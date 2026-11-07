// Safe to import from client AND server code (no secrets, no Node APIs).
//
// A model "ref" looks like  provider:model-id   e.g.
//   gemini:gemini-3.5-flash-lite
//   groq:llama-3.3-70b-versatile
//   openrouter:google/gemma-3-27b-it:free
//   cloudflare:@cf/black-forest-labs/flux-1-schnell
// A ref with no prefix is treated as a Gemini model.

export type Provider = "gemini" | "groq" | "openrouter" | "cloudflare";

export const PROVIDERS: Provider[] = ["gemini", "groq", "openrouter", "cloudflare"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: "Google Gemini",
  groq: "Groq · free tier",
  openrouter: "OpenRouter · free models",
  cloudflare: "Cloudflare Workers AI · free tier",
};

export const PROVIDER_ENV: Record<Provider, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cloudflare: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
};

export type ModelOption = {
  ref: string;
  label: string;
  provider: Provider;
  /** Can read an uploaded image as input (text models). */
  vision?: boolean;
  /** Can use your uploaded image as a visual reference (image models). Default true. */
  reference?: boolean;
  note?: string;
};

// Order = fallback priority when "auto-switch" is on.
// Model IDs change often: check each provider's docs and edit freely.
// Last checked: November 2026.
export const TEXT_MODELS: ModelOption[] = [
  { ref: "gemini:gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "gemini", vision: true, note: "Highest Gemini free limits" },
  { ref: "gemini:gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "gemini", vision: true, note: "Free tier is very small" },
  { ref: "groq:meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (reads images)", provider: "groq", vision: true, note: "~30 requests/min free" },
  { ref: "groq:llama-3.3-70b-versatile", label: "Llama 3.3 70B", provider: "groq", vision: false, note: "Text only · ~30 requests/min free" },
  { ref: "gemini:gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini", vision: true },
  { ref: "gemini:gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "gemini", vision: true },
  { ref: "groq:qwen/qwen3-32b", label: "Qwen3 32B", provider: "groq", vision: false },
  { ref: "groq:openai/gpt-oss-20b", label: "GPT-OSS 20B", provider: "groq", vision: false },
  { ref: "groq:llama-3.1-8b-instant", label: "Llama 3.1 8B (fastest)", provider: "groq", vision: false, note: "Highest daily limits" },
  { ref: "openrouter:google/gemma-3-27b-it:free", label: "Gemma 3 27B (free)", provider: "openrouter", vision: true, note: "Free model IDs change often" },
  { ref: "openrouter:meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)", provider: "openrouter", vision: false },
];

export const IMAGE_MODELS: ModelOption[] = [
  { ref: "gemini:gemini-3.1-flash-image", label: "Nano Banana 2 (Gemini 3.1 Flash Image)", provider: "gemini", reference: true, note: "Needs billing on most keys" },
  { ref: "gemini:gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)", provider: "gemini", reference: true, note: "No free tier" },
  { ref: "gemini:gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image (being retired)", provider: "gemini", reference: true },
  { ref: "cloudflare:@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 schnell", provider: "cloudflare", reference: false, note: "Free ~200 images/day · text prompt only" },
  { ref: "cloudflare:@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL", provider: "cloudflare", reference: false, note: "Free · text prompt only" },
];

export const CUSTOM_MODEL = "__custom__";

export type RunSettings = {
  textModel: string; // ref
  imageModel: string; // ref
  textTemperature: number; // 0 - 2
  imageTemperature: number; // 0 - 2
  fallback: boolean; // switch to another configured model/provider on overload / quota errors
  review: boolean; // pause after the steps so you can choose what to generate
};

export const DEFAULT_SETTINGS: RunSettings = {
  textModel: TEXT_MODELS[0].ref,
  imageModel: IMAGE_MODELS[0].ref,
  textTemperature: 1,
  imageTemperature: 1,
  fallback: true,
  review: true,
};

export function parseModelRef(ref: string): { provider: Provider; model: string } {
  const i = ref.indexOf(":");
  if (i > 0) {
    const p = ref.slice(0, i) as Provider;
    if (PROVIDERS.includes(p)) return { provider: p, model: ref.slice(i + 1) };
  }
  return { provider: "gemini", model: ref };
}

export function normalizeRef(ref: string) {
  const { provider, model } = parseModelRef(ref);
  return `${provider}:${model}`;
}

// Model IDs end up inside URLs / JSON, so keep them strict.
export function isValidModelRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[A-Za-z0-9._:@\/-]{3,140}$/.test(ref);
}

export function getModelMeta(ref: string, kind: "text" | "image") {
  const n = normalizeRef(ref);
  return (kind === "text" ? TEXT_MODELS : IMAGE_MODELS).find((m) => m.ref === n);
}

/** Unknown / custom models are assumed capable so your explicit pick isn't blocked. */
export function isVisionModel(ref: string) {
  return getModelMeta(ref, "text")?.vision ?? true;
}

export function supportsReference(ref: string) {
  return getModelMeta(ref, "image")?.reference ?? true;
}