import {
  IMAGE_MODELS,
  PROVIDER_ENV,
  TEXT_MODELS,
  isValidModelRef,
  isVisionModel,
  normalizeRef,
  parseModelRef,
  type Provider,
} from "@/lib/ai-models";

export type InputImage = { data: string; mimeType: string };

export type Attempt = {
  model: string;
  status?: number;
  error: string;
  quota?: QuotaKind;
};

export type QuotaKind = "none" | "rate" | "long";

export class AIError extends Error {
  status?: number;
  attempts?: Attempt[];
  model?: string;
  /** 429 only. none = this key has 0 quota for the model, rate = per-minute limit, long = daily/other long wait */
  quota?: QuotaKind;
  retryAfter?: number; // seconds
  /** Force trying the next model even if the status isn't normally retryable. */
  fallback?: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Statuses where trying a different model makes sense.
const RETRYABLE = new Set([404, 408, 413, 429, 500, 502, 503, 504]);
const MAX_WAIT_SECONDS = 25;

/* ---------- providers / keys ---------- */

export function providerConfigured(p: Provider) {
  switch (p) {
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "groq":
      return Boolean(process.env.GROQ_API_KEY);
    case "openrouter":
      return Boolean(process.env.OPENROUTER_API_KEY);
    case "cloudflare":
      return Boolean(
          process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
      );
  }
}

export function providerStatus(): Record<Provider, boolean> {
  return {
    gemini: providerConfigured("gemini"),
    groq: providerConfigured("groq"),
    openrouter: providerConfigured("openrouter"),
    cloudflare: providerConfigured("cloudflare"),
  };
}

function notConfigured(p: Provider) {
  const err = new AIError(`${PROVIDER_ENV[p]} is not set on the server.`, 500);
  err.fallback = true;
  return err;
}

/* ---------- helpers ---------- */

export function clampTemperature(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

export function parseInputImage(image: unknown): InputImage | undefined {
  if (image == null) return undefined;

  const img = image as Partial<InputImage>;

  if (
      typeof img !== "object" ||
      typeof img.data !== "string" ||
      typeof img.mimeType !== "string"
  ) {
    throw new AIError("Invalid image data.", 400);
  }
  if (!ALLOWED_IMAGE_TYPES.includes(img.mimeType)) {
    throw new AIError("Only JPG, PNG and WebP images are supported.", 400);
  }
  if (
      !img.data ||
      img.data.length > 14_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)
  ) {
    throw new AIError(
        "Invalid image data or image is too large. Maximum upload size is 10 MB.",
        400,
    );
  }
  return { data: img.data, mimeType: img.mimeType };
}

function sniffMime(b64: string): string | null {
  const head = b64.slice(0, 12);
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("UklGR")) return "image/webp";
  return null;
}

function parseRetrySeconds(message: string, header?: string | null) {
  if (header && Number.isFinite(Number(header))) return Number(header);
  const m = message.match(
      /(?:retry|try again)[^0-9]{0,12}((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i,
  );
  if (!m) return undefined;
  let total = 0;
  for (const t of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const n = Number(t[1]);
    const u = t[2].toLowerCase();
    total +=
        u === "ms" ? n / 1000 : u === "s" ? n : u === "m" ? n * 60 : n * 3600;
  }
  return total || undefined;
}

function httpError(
    ref: string,
    status: number,
    raw: string,
    retryHeader?: string | null,
) {
  let message = raw;
  try {
    const j = JSON.parse(raw);
    const m =
        j?.error?.message ?? j?.errors?.[0]?.message ?? j?.error ?? j?.message;
    if (m) message = typeof m === "string" ? m : JSON.stringify(m);
  } catch {
    /* keep raw */
  }

  const err = new AIError((message || "Unknown error").slice(0, 600), status);
  err.model = ref;

  if (status === 429) {
    err.retryAfter = parseRetrySeconds(message, retryHeader);
    if (/limit:\s*0\b/.test(message)) err.quota = "none";
    else if (err.retryAfter !== undefined && err.retryAfter <= 60)
      err.quota = "rate";
    else err.quota = "long";
  }
  return err;
}

async function timedFetch(
    ref: string,
    url: string,
    init: RequestInit,
    ms: number,
) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const name = (e as Error).name;
    const err = new AIError(
        name === "TimeoutError" || name === "AbortError"
            ? `${ref} timed out after ${Math.round(ms / 1000)} seconds.`
            : `Could not reach ${ref}: ${(e as Error).message}`,
        name === "TimeoutError" || name === "AbortError" ? 504 : 502,
    );
    err.model = ref;
    throw err;
  }
}

/* ---------- Gemini ---------- */

type GeminiResponse = {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    finishReason?: string;
    content?: {
      parts?: {
        text?: string;
        inlineData?: { data: string; mimeType: string };
        inline_data?: { data: string; mime_type: string };
      }[];
    };
  }[];
};

async function callGemini(opts: {
  model: string;
  prompt: string;
  inputImage?: InputImage;
  generateImage?: boolean;
  temperature?: number;
}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw notConfigured("gemini");

  const {
    model,
    prompt,
    inputImage,
    generateImage = false,
    temperature,
  } = opts;
  const ref = `gemini:${model}`;

  const parts: Record<string, unknown>[] = [];
  if (inputImage)
    parts.push({
      inlineData: { mimeType: inputImage.mimeType, data: inputImage.data },
    });
  parts.push({ text: prompt });

  const generationConfig: Record<string, unknown> = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (generateImage) generationConfig.responseModalities = ["TEXT", "IMAGE"];

  const response = await timedFetch(
      ref,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      },
      90_000,
  );

  const raw = await response.text();
  if (!response.ok) {
    console.error("[Gemini error]", {
      model,
      status: response.status,
      body: raw.slice(0, 500),
    });
    throw httpError(
        ref,
        response.status,
        raw,
        response.headers.get("retry-after"),
    );
  }

  let json: GeminiResponse = {};
  try {
    json = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  if (json.promptFeedback?.blockReason) {
    const err = new AIError(
        `${ref} blocked the prompt (${json.promptFeedback.blockReason}). Try rewording it.`,
        400,
    );
    err.model = ref;
    throw err;
  }

  const candidate = json.candidates?.[0];
  const responseParts = candidate?.content?.parts || [];
  const text = responseParts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join("\n")
      .trim();

  let image: InputImage | null = null;
  for (const p of responseParts) {
    const data = p.inlineData?.data || p.inline_data?.data;
    if (data) {
      image = {
        data,
        mimeType:
            p.inlineData?.mimeType || p.inline_data?.mime_type || "image/png",
      };
      break;
    }
  }

  const why = candidate?.finishReason
      ? ` (finish reason: ${candidate.finishReason})`
      : "";

  if (generateImage) {
    if (!image) {
      const said = text ? ` It replied: "${text.slice(0, 160)}"` : "";
      throw Object.assign(
          new AIError(`${ref} did not return an image${why}.${said}`, 502),
          { model: ref },
      );
    }
    const sniffed = sniffMime(image.data);
    if (!sniffed)
      throw Object.assign(
          new AIError(`${ref} returned data that is not a valid image.`, 502),
          { model: ref },
      );
    image.mimeType = sniffed;
    return { text, image };
  }

  if (!text)
    throw Object.assign(
        new AIError(`${ref} returned an empty response${why}.`, 502),
        { model: ref },
    );
  return { text, image };
}

/* ---------- OpenAI-compatible (Groq, OpenRouter) ---------- */

async function callOpenAICompat(opts: {
  provider: "groq" | "openrouter";
  model: string;
  prompt: string;
  inputImage?: InputImage;
  temperature?: number;
}) {
  const { provider, model, prompt, inputImage, temperature } = opts;
  const ref = `${provider}:${model}`;
  const key =
      provider === "groq"
          ? process.env.GROQ_API_KEY
          : process.env.OPENROUTER_API_KEY;
  if (!key) throw notConfigured(provider);

  // Groq vision accepts roughly 4 MB of base64 per request.
  if (provider === "groq" && inputImage && inputImage.data.length > 5_300_000) {
    const err = new AIError(
        "This image is too large for Groq vision (about 4 MB limit).",
        413,
    );
    err.model = ref;
    err.fallback = true;
    throw err;
  }

  const base =
      provider === "groq"
          ? "https://api.groq.com/openai/v1"
          : "https://openrouter.ai/api/v1";

  const content = inputImage
      ? [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${inputImage.mimeType};base64,${inputImage.data}`,
          },
        },
      ]
      : prompt;

  const response = await timedFetch(
      ref,
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          ...(temperature !== undefined ? { temperature } : {}),
        }),
      },
      60_000,
  );

  const raw = await response.text();
  if (!response.ok) {
    console.error(`[${provider} error]`, {
      model,
      status: response.status,
      body: raw.slice(0, 500),
    });
    throw httpError(
        ref,
        response.status,
        raw,
        response.headers.get("retry-after"),
    );
  }

  let text = "";
  try {
    const c = JSON.parse(raw)?.choices?.[0]?.message?.content;
    text =
        typeof c === "string"
            ? c
            : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text || "").join("\n")
                : "";
  } catch {
    /* ignore */
  }

  // Some reasoning models include their chain of thought in <think> tags.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  if (!text)
    throw Object.assign(
        new AIError(`${ref} returned an empty response.`, 502),
        { model: ref },
    );
  return { text };
}

/* ---------- Cloudflare Workers AI (images) ---------- */

async function callCloudflareImage(
    model: string,
    prompt: string,
): Promise<InputImage> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw notConfigured("cloudflare");

  const ref = `cloudflare:${model}`;
  const isFlux = model.includes("flux");

  const response = await timedFetch(
      ref,
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prompt: prompt.slice(0, 2000),
          ...(isFlux ? { steps: 8 } : {}),
        }),
      },
      90_000,
  );

  if (!response.ok) {
    const raw = await response.text();
    console.error("[Cloudflare error]", {
      model,
      status: response.status,
      body: raw.slice(0, 500),
    });
    throw httpError(
        ref,
        response.status,
        raw,
        response.headers.get("retry-after"),
    );
  }

  let b64 = "";
  if ((response.headers.get("content-type") || "").includes("json")) {
    // FLUX returns JSON with the image base64-encoded inside.
    const j = await response.json();
    b64 = j?.result?.image || "";
  } else {
    // Stable Diffusion models return raw image bytes.
    b64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  }

  const mime = b64 ? sniffMime(b64) : null;
  if (!mime)
    throw Object.assign(
        new AIError(`${ref} did not return a valid image.`, 502),
        { model: ref },
    );
  return { data: b64, mimeType: mime };
}

/* ---------- public entry points ---------- */

export async function generateText(
    ref: string,
    o: { prompt: string; inputImage?: InputImage; temperature?: number },
): Promise<string> {
  const { provider, model } = parseModelRef(ref);

  if (provider === "gemini") return (await callGemini({ model, ...o })).text;
  if (provider === "groq" || provider === "openrouter") {
    return (await callOpenAICompat({ provider, model, ...o })).text;
  }
  throw new AIError(`${ref} cannot generate text.`, 400);
}

export async function generateImage(
    ref: string,
    o: { prompt: string; reference?: InputImage; temperature?: number },
): Promise<InputImage> {
  const { provider, model } = parseModelRef(ref);

  if (provider === "gemini") {
    const r = await callGemini({
      model,
      prompt: o.prompt,
      inputImage: o.reference,
      generateImage: true,
      temperature: o.temperature,
    });
    return r.image!;
  }
  if (provider === "cloudflare") return callCloudflareImage(model, o.prompt);
  throw new AIError(
      `${ref} cannot generate images. Pick a Gemini or Cloudflare image model.`,
      400,
  );
}

/** Selected model first, then (optionally) every other preset whose provider has a key configured. */
export function buildModelList(
    selected: unknown,
    kind: "text" | "image",
    fallback: boolean,
) {
  const presets = (kind === "text" ? TEXT_MODELS : IMAGE_MODELS).map(
      (m) => m.ref,
  );
  const first = isValidModelRef(selected) ? normalizeRef(selected) : presets[0];
  if (!fallback) return [first];

  const others = presets.filter(
      (r) => r !== first && providerConfigured(parseModelRef(r).provider),
  );
  return [first, ...others];
}

export function visionOnly(models: string[]) {
  return models.filter((m) => isVisionModel(m));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries each model in order. Short per-minute rate limits are waited out once
 * (up to 25s) before moving on; "no quota", daily limits and outages move on immediately.
 */
export async function runWithFallback<T>(
    models: string[],
    run: (model: string) => Promise<T>,
) {
  const attempts: Attempt[] = [];
  let last: AIError | undefined;

  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await run(model);
        return { result, model, attempts };
      } catch (e) {
        const err =
            e instanceof AIError
                ? e
                : new AIError((e as Error).message || "Unknown error", 502);
        err.model = err.model || model;

        if (
            err.status === 429 &&
            err.quota === "rate" &&
            err.retryAfter !== undefined &&
            err.retryAfter <= MAX_WAIT_SECONDS &&
            attempt === 0
        ) {
          await sleep((err.retryAfter + 0.5) * 1000);
          continue;
        }

        attempts.push({
          model,
          status: err.status,
          error: err.message,
          quota: err.quota,
        });
        last = err;

        if (!(err.fallback || RETRYABLE.has(err.status ?? 0))) break outer;
        break; // next model
      }
    }
  }

  const failure = last ?? new AIError("No model available.", 500);
  failure.attempts = attempts;
  throw failure;
}

export function errorResponseBody(
    error: AIError,
    extra: Record<string, unknown> = {},
) {
  const attempts: Attempt[] = error.attempts?.length
      ? error.attempts
      : [
        {
          model: error.model || "model",
          status: error.status,
          error: error.message,
          quota: error.quota,
        },
      ];

  const lines = attempts.map((a) => {
    const tag =
        a.quota === "none"
            ? "no free quota on your key (limit 0)"
            : a.quota === "rate"
                ? "per-minute limit"
                : a.quota === "long"
                    ? "quota used up for now"
                    : (a.status ?? "error");
    return `• ${a.model} — ${tag}: ${a.error.replace(/\s+/g, " ").slice(0, 170)}`;
  });

  const noQuota = attempts.some((a) => a.quota === "none");
  const anyQuota = attempts.some((a) => a.status === 429);

  const headline =
      attempts.length > 1
          ? `None of the ${attempts.length} models worked.`
          : "The model request failed.";

  const hint = noQuota
      ? "\nSome models have zero free quota on your key, so waiting won't fix them. Use Groq (free) for text, Cloudflare (free) for images, or enable billing in Google AI Studio."
      : anyQuota
          ? "\nFree tiers have small per-minute and per-day limits. Wait a minute, or switch provider."
          : "";

  return {
    error: `${headline}\n${lines.join("\n")}${hint}`,
    code: anyQuota ? "QUOTA_EXCEEDED" : undefined,
    attempts,
    ...extra,
  };
}

export function statusFor(error: AIError) {
  return error.status && error.status >= 400 && error.status < 600
      ? error.status
      : 502;
}

/** Removes markdown formatting (**bold**, *italic*, # headings, `code`) from model output. */
/** Removes markdown formatting (**bold**, *italic*, # headings, `code`) from model output. */
export function stripMarkdown(text: string) {
  return text
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*\*\s+/gm, "- ")
      .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
      .replace(/__([\s\S]+?)__/g, "$1")
      .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1$2")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
}