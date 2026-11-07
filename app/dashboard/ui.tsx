"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import {
  CUSTOM_MODEL,
  DEFAULT_SETTINGS,
  IMAGE_MODELS,
  PROVIDERS,
  PROVIDER_ENV,
  PROVIDER_LABELS,
  TEXT_MODELS,
  getModelMeta,
  supportsReference,
  type ModelOption,
  type Provider,
  type RunSettings,
} from "@/lib/ai-models";
import { parseNumberedOptions } from "@/lib/parse-options";

type Chain = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type Step = {
  id: string;
  chain_id: string;
  step_order: number;
  name: string;
  prompt_template: string;
  enabled: boolean;
};

type Media = {
  id: string;
  chain_id: string;
  prompt: string;
  storage_path: string;
  created_at: string;
  url?: string;
};

type StepOutput = { step: string; output: string; model?: string };

type GeneratedResult = {
  url: string;
  prompt: string;
  model?: string;
};

type ImagePayload = { data: string; mimeType: string };

type Providers = Record<Provider, boolean> | null;

// Live state of a chain run (one request per step).
type RunState = {
  status: "running" | "failed" | "done";
  steps: { id: string; name: string }[];
  outputs: StepOutput[];
  current: number;
  error: string;
  input: string;
  image?: ImagePayload;
};

// What the "choose what to generate" modal edits.
type ReviewState = {
  outputs: StepOutput[];
  finalOutput: string;
  options: string[];
  mode: "options" | "single";
  choice: number;
  intent: "concept" | "caption";
  promptText: string;
  includeRef: boolean;
  image?: ImagePayload;
};

async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(json.error || "Request failed");
  }

  return json;
}

function fileToBase64(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIndex = result.indexOf(",");

      if (commaIndex === -1) {
        reject(new Error("Could not read the selected image."));
        return;
      }

      resolve({ data: result.slice(commaIndex + 1), mimeType: file.type });
    };

    reader.onerror = () =>
        reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

// Draws the caption on a white banner above the photo (classic meme layout).
// Shrinks big photos so they upload reliably. No text is drawn on the image.
async function resizePhoto(image: ImagePayload): Promise<ImagePayload> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new window.Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not load your photo."));
    el.src = `data:${image.mimeType};base64,${image.data}`;
  });

  const scale = Math.min(
      1,
      1600 / Math.max(img.naturalWidth, img.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images.");

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  return {
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mimeType: "image/jpeg",
  };
}

// Confirms the browser can actually decode the generated image before we save it.
function verifyImage(src: string) {
  return new Promise<void>((resolve, reject) => {
    const img = new window.Image();
    img.onload = () =>
        img.naturalWidth > 0
            ? resolve()
            : reject(new Error("The generated image is empty."));
    img.onerror = () =>
        reject(new Error("The generated image could not be decoded."));
    img.src = src;
  });
}

// Turns the chosen option / full output into the prompt sent to the image model.
function composePrompt(
    r: Pick<
        ReviewState,
        "mode" | "choice" | "options" | "finalOutput" | "intent"
    >,
) {
  const base =
      r.mode === "options" && r.choice >= 0 ? r.options[r.choice] : r.finalOutput;

  return r.intent === "caption"
      ? `Use the reference image as the main visual and add this caption to it as clear, legible text: "${base}"`
      : base;
}

function selectedText(r: ReviewState) {
  return r.mode === "options" && r.choice >= 0
      ? r.options[r.choice]
      : r.finalOutput;
}

function modelLabel(ref: string, kind: "text" | "image") {
  return getModelMeta(ref, kind)?.label || ref;
}

/* ------------------------------------------------------------------ */
/* Small components                                                    */
/* ------------------------------------------------------------------ */

function ModelSelect({
                       label,
                       kind,
                       value,
                       providers,
                       onChange,
                       disabled,
                     }: {
  label: string;
  kind: "text" | "image";
  value: string;
  providers: Providers;
  onChange: (ref: string) => void;
  disabled?: boolean;
}) {
  const options: ModelOption[] = kind === "text" ? TEXT_MODELS : IMAGE_MODELS;
  const meta = options.find((option) => option.ref === value);
  const [customMode, setCustomMode] = useState(!meta);
  const showCustom = customMode || !meta;

  const missing = (provider: Provider) =>
      providers !== null && !providers[provider];

  return (
      <div className="setting">
        <label>{label}</label>

        <select
            className="theme-select"
            value={showCustom ? CUSTOM_MODEL : value}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value === CUSTOM_MODEL) {
                setCustomMode(true);
              } else {
                setCustomMode(false);
                onChange(event.target.value);
              }
            }}
        >
          {PROVIDERS.map((provider) => {
            const group = options.filter(
                (option) => option.provider === provider,
            );
            if (!group.length) return null;

            return (
                <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
                  {group.map((option) => (
                      <option
                          key={option.ref}
                          value={option.ref}
                          disabled={missing(provider)}
                      >
                        {option.label}
                        {missing(provider) ? " (key missing)" : ""}
                      </option>
                  ))}
                </optgroup>
            );
          })}
          <option value={CUSTOM_MODEL}>Custom model…</option>
        </select>

        {showCustom ? (
            <input
                className="field"
                placeholder="provider:model-id  e.g. groq:llama-3.3-70b-versatile"
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value.trim())}
            />
        ) : (
            meta?.note && <span className="setting-note">{meta.note}</span>
        )}
      </div>
  );
}

function Segmented<T extends string>({
                                       value,
                                       options,
                                       onChange,
                                       disabled,
                                     }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
      <div className="segmented" role="group">
        {options.map((option) => (
            <button
                key={option.value}
                type="button"
                disabled={disabled}
                className={value === option.value ? "seg active" : "seg"}
                onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
        ))}
      </div>
  );
}

function RunProgress({
                       run,
                       busy,
                       onRetry,
                       onDismiss,
                     }: {
  run: RunState;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
      <div className="progress">
        <div className="progress-head">
          <b>
            {run.status === "running" &&
                `Running step ${run.current + 1} of ${run.steps.length}…`}
            {run.status === "failed" &&
                `Stopped at step ${run.outputs.length + 1} of ${run.steps.length}`}
            {run.status === "done" && `All ${run.steps.length} steps finished`}
          </b>

          {run.status !== "running" && (
              <button className="btn btn-quiet" onClick={onDismiss}>
                Clear
              </button>
          )}
        </div>

        <ol className="progress-list">
          {run.steps.map((step, index) => {
            const output = run.outputs[index];
            const failed =
                run.status === "failed" && index === run.outputs.length;
            const running =
                run.status === "running" && index === run.current && !output;
            const state = output
                ? "done"
                : failed
                    ? "failed"
                    : running
                        ? "running"
                        : "pending";

            return (
                <li key={step.id} className={`progress-item ${state}`}>
              <span className="progress-icon" aria-hidden>
                {state === "done" && "✓"}
                {state === "failed" && "!"}
                {state === "running" && <span className="spinner" />}
                {state === "pending" && index + 1}
              </span>

                  <div className="progress-body">
                    <div className="progress-title">
                      <span>{step.name}</span>
                      {output?.model && (
                          <span className="model-tag">{output.model}</span>
                      )}
                      {running && <span className="muted">working…</span>}
                    </div>

                    {output && (
                        <details className="progress-output">
                          <summary>View output</summary>
                          <p>{output.output}</p>
                        </details>
                    )}

                    {failed && (
                        <div className="error-box">
                          <pre>{run.error}</pre>
                          <div className="error-actions">
                            <button
                                className="btn btn-primary"
                                disabled={busy}
                                onClick={onRetry}
                            >
                              Retry this step
                            </button>
                            <span className="muted">
                        Finished steps are kept. You can change the model in
                        settings first.
                      </span>
                          </div>
                        </div>
                    )}
                  </div>
                </li>
            );
          })}
        </ol>
      </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export default function Dashboard({ email }: { email: string }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [selected, setSelected] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [media, setMedia] = useState<Media[]>([]);

  const [tab, setTab] = useState<"chains" | "media">("chains");
  const [mediaFilter, setMediaFilter] = useState("all");

  const [chainName, setChainName] = useState("");
  const [chainDescription, setChainDescription] = useState("");
  const [stepName, setStepName] = useState("");
  const [template, setTemplate] = useState("");
  const [input, setInput] = useState("");

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");

  const [editChain, setEditChain] = useState(false);
  const [creatingChain, setCreatingChain] = useState(false);
  const [editStep, setEditStep] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [theme, setTheme] = useState("system");

  const [generated, setGenerated] = useState<GeneratedResult | null>(null);

  const [settings, setSettings] = useState<RunSettings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<Providers>(null);

  const [run, setRun] = useState<RunState | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewError, setReviewError] = useState("");

  const active = chains.find((chain) => chain.id === selected);

  const loadChains = useCallback(async () => {
    try {
      const data = await api("/api/chains");
      setChains(data);
      setSelected((old) => old || data[0]?.id || "");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);

  const loadSteps = useCallback(async (id: string) => {
    if (!id) return;

    try {
      setSteps(await api(`/api/chains/${id}/steps`));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);

  const loadMedia = useCallback(async () => {
    try {
      setMedia(await api("/api/media"));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);

  useEffect(() => {
    loadChains();
    loadMedia();
    api("/api/ai-providers")
        .then(setProviders)
        .catch(() => setProviders(null));
  }, [loadChains, loadMedia]);

  useEffect(() => {
    loadSteps(selected);
  }, [selected, loadSteps]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!imageFile) {
      setImagePreview("");
      return;
    }

    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);

    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  // Settings are remembered per chain, in this browser.
  useEffect(() => {
    if (!selected) return;

    try {
      const raw = window.localStorage.getItem(`chain-settings-v3:${selected}`);
      setSettings({ ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) });
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, [selected]);

  // Esc closes the modal (unless something is generating).
  useEffect(() => {
    if (!review || busy) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReview(null);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review, busy]);

  function updateSettings(patch: Partial<RunSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);

    try {
      if (selected) {
        window.localStorage.setItem(
            `chain-settings-v3:${selected}`,
            JSON.stringify(next),
        );
      }
    } catch {
      // storage may be unavailable; settings just won't persist
    }
  }

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 4500);
  };

  /* ---------------- chains & steps ---------------- */

  async function saveChain() {
    setBusy(true);

    try {
      if (editChain && active && !creatingChain) {
        await api(`/api/chains/${active.id}`, "PATCH", {
          name: chainName,
          description: chainDescription,
        });

        notify("Chain updated.");
      } else {
        const chain = await api("/api/chains", "POST", {
          name: chainName,
          description: chainDescription,
        });

        setSelected(chain.id);
        notify("Chain created.");
      }

      setChainName("");
      setChainDescription("");
      setEditChain(false);
      setCreatingChain(false);

      await loadChains();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startEditChain() {
    if (!active) return;

    setChainName(active.name);
    setChainDescription(active.description || "");
    setEditChain(true);
  }

  async function deleteChain() {
    if (!active || !confirm(`Delete "${active.name}" and all its steps?`))
      return;

    try {
      await api(`/api/chains/${active.id}`, "DELETE");
      setSelected("");
      await loadChains();
      setSteps([]);
      notify("Chain deleted.");
    } catch (error) {
      notify((error as Error).message);
    }
  }

  async function saveStep() {
    if (!selected) return;

    setBusy(true);

    try {
      if (editStep) {
        await api(`/api/steps/${editStep}`, "PATCH", {
          name: stepName,
          prompt_template: template,
        });
      } else {
        await api(`/api/chains/${selected}/steps`, "POST", {
          name: stepName,
          prompt_template: template,
        });
      }

      setStepName("");
      setTemplate("");
      setEditStep("");

      await loadSteps(selected);
      notify("Step saved.");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function editExistingStep(step: Step) {
    setEditStep(step.id);
    setStepName(step.name);
    setTemplate(step.prompt_template);
  }

  async function deleteStep(id: string) {
    if (!confirm("Delete this step?")) return;

    try {
      await api(`/api/steps/${id}`, "DELETE");
      await loadSteps(selected);
      notify("Step deleted.");
    } catch (error) {
      notify((error as Error).message);
    }
  }

  async function moveStep(index: number, delta: number) {
    const next = [...steps];
    const target = index + delta;

    if (target < 0 || target >= next.length) return;

    [next[index], next[target]] = [next[target], next[index]];

    setSteps(next);

    try {
      await api(`/api/chains/${selected}/reorder`, "POST", {
        orderedIds: next.map((step) => step.id),
      });
    } catch (error) {
      notify((error as Error).message);
      await loadSteps(selected);
    }
  }

  async function toggleChain() {
    if (!active) return;

    try {
      await api(`/api/chains/${active.id}`, "PATCH", {
        enabled: !active.enabled,
      });
      await loadChains();
    } catch (error) {
      notify((error as Error).message);
    }
  }

  async function toggleStep(step: Step) {
    try {
      await api(`/api/steps/${step.id}`, "PATCH", { enabled: !step.enabled });
      await loadSteps(selected);
    } catch (error) {
      notify((error as Error).message);
    }
  }

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      notify("Please select a JPG, PNG or WebP image.");
      event.target.value = "";
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      notify("Image must be 10 MB or smaller.");
      event.target.value = "";
      return;
    }

    setImageFile(file);
    setGenerated(null);
  }

  function removeImage() {
    setImageFile(null);

    const fileInput = document.getElementById(
        "chain-image-input",
    ) as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
  }

  /* ---------------- running a chain ---------------- */

  // Step 2 of the flow: image generation from the chosen prompt.
  async function generateMedia(state: ReviewState) {
    const promptText = state.promptText.trim();

    if (!promptText) {
      setReviewError("Choose an option or write a prompt first.");
      return;
    }

    setBusy(true);
    setReviewError("");

    try {
      const result = await api(
          `/api/chains/${selected}/generate-image`,
          "POST",
          {
            prompt: promptText,
            image: state.includeRef ? state.image : undefined,
            imageModel: settings.imageModel,
            temperature: settings.imageTemperature,
            fallback: settings.fallback,
          },
      );

      if (!result.image?.data || !result.image?.mimeType) {
        throw new Error("Generation finished, but no image was returned.");
      }

      await verifyImage(
          `data:${result.image.mimeType};base64,${result.image.data}`,
      );

      const saved = await api("/api/media", "POST", {
        chain_id: selected,
        prompt: promptText,
        base64: result.image.data,
        mimeType: result.image.mimeType,
      });

      setGenerated({ url: saved.url, prompt: promptText, model: result.model });
      setReview(null);
      await loadMedia();
      notify(`Image created with ${result.model} and saved.`);
    } catch (error) {
      // Keep everything on screen so you can retry or switch model.
      setReview({ ...state, promptText });
      setReviewError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Puts the chosen caption on the user's own photo and saves it to Generated media.
  // Saves the user's own photo together with the chosen caption (caption is shown below it).
  async function makeMeme(state: ReviewState) {
    if (!state.image) return;

    const caption = selectedText(state).trim();

    if (!caption) {
      setReviewError("Pick a caption first.");
      return;
    }

    setBusy(true);
    setReviewError("");

    try {
      const photo = await resizePhoto(state.image);

      const saved = await api("/api/media", "POST", {
        chain_id: selected,
        prompt: caption,
        base64: photo.data,
        mimeType: photo.mimeType,
      });

      setGenerated({ url: saved.url, prompt: caption, model: "Your photo" });
      setReview(null);
      await loadMedia();
      notify("Photo and caption saved.");
    } catch (error) {
      setReviewError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function afterSteps(done: RunState) {
    const finalOutput = done.outputs[done.outputs.length - 1]?.output ?? "";
    const options = parseNumberedOptions(finalOutput);

    const base = {
      outputs: done.outputs,
      finalOutput,
      options,
      mode: (options.length >= 2 ? "options" : "single") as
          | "options"
          | "single",
      choice: options.length >= 2 ? 0 : -1,
      intent: "concept" as const,
      includeRef: Boolean(done.image),
      image: done.image,
    };

    const state: ReviewState = { ...base, promptText: composePrompt(base) };

    if (settings.review) {
      setReview(state);
      setReviewError("");
      setBusy(false);
      return;
    }

    await generateMedia(state);
  }

  // Runs steps one request at a time, from `start`. Used for the first run and for "Retry this step".
  async function runFrom(base: RunState, start: number) {
    const total = base.steps.length;
    const outputs = base.outputs.slice(0, start);
    let state: RunState = {
      ...base,
      status: "running",
      error: "",
      outputs: [...outputs],
    };

    setBusy(true);
    setReview(null);
    setGenerated(null);
    setRun(state);

    try {
      for (let i = start; i < total; i++) {
        state = { ...state, current: i, outputs: [...outputs] };
        setRun(state);

        const result = await api(`/api/chains/${selected}/execute`, "POST", {
          stepId: state.steps[i].id,
          stepNumber: i + 1,
          totalSteps: total,
          input: state.input,
          previousOutput: i === 0 ? "" : outputs[i - 1].output,
          image: i === 0 ? state.image : undefined,
          textModel: settings.textModel,
          temperature: settings.textTemperature,
          fallback: settings.fallback,
        });

        outputs.push({
          step: state.steps[i].name,
          output: result.output,
          model: result.model,
        });
        state = { ...state, outputs: [...outputs] };
        setRun(state);
      }
    } catch (error) {
      setRun({
        ...state,
        status: "failed",
        error: (error as Error).message,
        outputs: [...outputs],
      });
      setBusy(false);
      return;
    }

    const done: RunState = {
      ...state,
      status: "done",
      current: total,
      outputs: [...outputs],
    };
    setRun(done);
    await afterSteps(done);
  }

  async function execute() {
    if (!active) return;

    if (!input.trim() && !imageFile) {
      notify("Enter some text or upload an image first.");
      return;
    }

    const enabledSteps = steps
        .filter((step) => step.enabled)
        .map((step) => ({ id: step.id, name: step.name }));

    if (!enabledSteps.length) {
      notify("Enable at least one step first.");
      return;
    }

    let image: ImagePayload | undefined;

    try {
      image = imageFile ? await fileToBase64(imageFile) : undefined;
    } catch (error) {
      notify((error as Error).message);
      return;
    }

    await runFrom(
        {
          status: "running",
          steps: enabledSteps,
          outputs: [],
          current: 0,
          error: "",
          input: input.trim(),
          image,
        },
        0,
    );
  }

  async function logout() {
    await signOut({ callbackUrl: "/login" });
  }

  /* ---------------- review modal helpers ---------------- */

  function updateReview(patch: Partial<ReviewState>) {
    setReview((previous) => {
      if (!previous) return previous;

      const next = { ...previous, ...patch };
      return patch.promptText !== undefined
          ? next
          : { ...next, promptText: composePrompt(next) };
    });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to clipboard.");
    } catch {
      notify("Could not copy. Select the text and copy it manually.");
    }
  }

  const mediaWithUrls = useMemo(() => media, [media]);

  const filteredMedia = mediaWithUrls.filter(
      (item) => mediaFilter === "all" || item.chain_id === mediaFilter,
  );

  const refSupported = supportsReference(settings.imageModel);
  const groqMissing = providers !== null && !providers.groq;

  /* ---------------- render ---------------- */

  return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">N</div>

            <div>
              <div className="brand-title">NYC UNHINGED</div>
              <div className="brand-sub">PROMPT CHAIN STUDIO</div>
            </div>
          </div>

          <div className="top-actions">
            <span className="user-email">{email}</span>

            <select
                className="theme-select"
                value={theme}
                onChange={(event) => setTheme(event.target.value)}
                aria-label="Theme"
            >
              <option value="system">System theme</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>

            <button className="btn btn-quiet" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>

        <section className="welcome">
          <div>
            <div className="eyebrow">CREATIVE WORKSPACE / ADMIN</div>

            <h1>
              Prompt chains, <em>made simple.</em>
            </h1>

            <p>
              Build repeatable creative workflows, run them with Gemini, Groq and
              more, and review the media you generate.
            </p>
          </div>

          <div className="welcome-chip">
            <span className="pulse" /> SUPERADMIN ACCESS
          </div>
        </section>

        {message && <div className="toast">{message}</div>}

        <nav className="tabs">
          <button
              className={tab === "chains" ? "tab active" : "tab"}
              onClick={() => setTab("chains")}
          >
            Prompt chains
          </button>

          <button
              className={tab === "media" ? "tab active" : "tab"}
              onClick={() => {
                setTab("media");
                loadMedia();
              }}
          >
            Generated media
          </button>
        </nav>

        {tab === "chains" ? (
            <div className="workspace">
              <aside className="chain-sidebar">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">LIBRARY</div>
                    <h2>Your chains</h2>
                  </div>

                  <span className="count-pill">{chains.length}</span>
                </div>

                <button
                    className="btn btn-primary full"
                    onClick={() => {
                      setEditChain(true);
                      setCreatingChain(true);
                      setChainName("New prompt chain");
                      setChainDescription("");
                    }}
                >
                  ＋ New chain
                </button>

                <div className="chain-list">
                  {chains.map((chain) => (
                      <button
                          key={chain.id}
                          className={`chain-item ${selected === chain.id ? "selected" : ""}`}
                          onClick={() => {
                            setSelected(chain.id);
                            setEditChain(false);
                            setGenerated(null);
                            setReview(null);
                            setRun(null);
                          }}
                      >
                        <span className="chain-dot" />

                        <span className="chain-copy">
                    <b>{chain.name}</b>
                    <small>{chain.description || "No description"}</small>
                  </span>

                        <span
                            className={chain.enabled ? "status-dot" : "status-dot off"}
                        />
                      </button>
                  ))}

                  {!chains.length && (
                      <p className="muted small-pad">
                        No chains yet. Create your first one.
                      </p>
                  )}
                </div>
              </aside>

              <section className="main-panel">
                {creatingChain && (
                    <div className="editor-card">
                      <div className="editor-title">Create a prompt chain</div>

                      <input
                          className="field"
                          placeholder="Chain name"
                          value={chainName}
                          onChange={(event) => setChainName(event.target.value)}
                      />

                      <textarea
                          className="field"
                          placeholder="Description"
                          value={chainDescription}
                          onChange={(event) => setChainDescription(event.target.value)}
                      />

                      <div className="form-actions">
                        <button
                            className="btn btn-secondary"
                            onClick={() => setCreatingChain(false)}
                        >
                          Cancel
                        </button>

                        <button
                            className="btn btn-primary"
                            disabled={busy || !chainName.trim()}
                            onClick={saveChain}
                        >
                          Create chain
                        </button>
                      </div>
                    </div>
                )}

                {active ? (
                    <>
                      <div className="panel-heading">
                        <div>
                          <div className="eyebrow">PROMPT CHAIN</div>
                          <h2>{active.name}</h2>
                          <p className="muted">
                            {active.description ||
                                "Add a description to explain what this chain does."}
                          </p>
                        </div>

                        <div className="heading-actions">
                          <button className="btn btn-secondary" onClick={toggleChain}>
                            {active.enabled ? "Disable" : "Enable"}
                          </button>

                          <button
                              className="btn btn-secondary"
                              onClick={startEditChain}
                          >
                            Edit
                          </button>

                          <button className="btn btn-danger" onClick={deleteChain}>
                            Delete
                          </button>
                        </div>
                      </div>

                      {editChain && !creatingChain && (
                          <div className="editor-card">
                            <div className="editor-title">Edit chain details</div>

                            <input
                                className="field"
                                placeholder="Chain name"
                                value={chainName}
                                onChange={(event) => setChainName(event.target.value)}
                            />

                            <textarea
                                className="field"
                                placeholder="Description"
                                value={chainDescription}
                                onChange={(event) =>
                                    setChainDescription(event.target.value)
                                }
                            />

                            <div className="form-actions">
                              <button
                                  className="btn btn-secondary"
                                  onClick={() => {
                                    setEditChain(false);
                                    setCreatingChain(false);
                                  }}
                              >
                                Cancel
                              </button>

                              <button
                                  className="btn btn-primary"
                                  disabled={busy}
                                  onClick={saveChain}
                              >
                                Save chain
                              </button>
                            </div>
                          </div>
                      )}

                      <div className="steps-head">
                        <div>
                          <div className="eyebrow">WORKFLOW</div>
                          <h3>
                            Chain steps{" "}
                            <span className="muted">({steps.length})</span>
                          </h3>
                        </div>

                        <span className="hint">
                    Use {"{{input}}"} and {"{{previous_output}}"} in templates
                  </span>
                      </div>

                      <div className="step-list">
                        {steps.map((step, index) => {
                          const long = step.prompt_template.length > 180;
                          const open = expanded[step.id];

                          return (
                              <article
                                  className={`step-card ${step.enabled ? "" : "is-off"}`}
                                  key={step.id}
                              >
                                <div className="step-number">
                                  {String(index + 1).padStart(2, "0")}
                                </div>

                                <div className="step-content">
                                  <div className="step-title-row">
                                    <h4>{step.name}</h4>

                                    <span
                                        className={
                                          step.enabled ? "enabled-tag" : "disabled-tag"
                                        }
                                    >
                              {step.enabled ? "Enabled" : "Disabled"}
                            </span>
                                  </div>

                                  <p className={long && !open ? "clamped" : ""}>
                                    {step.prompt_template}
                                  </p>

                                  {long && (
                                      <button
                                          className="link-btn"
                                          onClick={() =>
                                              setExpanded({ ...expanded, [step.id]: !open })
                                          }
                                      >
                                        {open ? "Show less" : "Show full prompt"}
                                      </button>
                                  )}
                                </div>

                                <div className="step-actions">
                                  <button
                                      title="Move up"
                                      disabled={index === 0}
                                      onClick={() => moveStep(index, -1)}
                                  >
                                    ↑
                                  </button>

                                  <button
                                      title="Move down"
                                      disabled={index === steps.length - 1}
                                      onClick={() => moveStep(index, 1)}
                                  >
                                    ↓
                                  </button>

                                  <button
                                      title={
                                        step.enabled ? "Disable step" : "Enable step"
                                      }
                                      onClick={() => toggleStep(step)}
                                  >
                                    {step.enabled ? "●" : "○"}
                                  </button>

                                  <button
                                      title="Edit"
                                      onClick={() => editExistingStep(step)}
                                  >
                                    ✎
                                  </button>

                                  <button
                                      title="Delete"
                                      onClick={() => deleteStep(step.id)}
                                  >
                                    ×
                                  </button>
                                </div>
                              </article>
                          );
                        })}

                        {!steps.length && (
                            <div className="empty-state">
                              <div className="empty-icon">✳</div>
                              <b>This chain is empty</b>
                              <span>Add a step to define what the AI should do.</span>
                            </div>
                        )}
                      </div>

                      <div className="editor-card">
                        <div className="editor-title">
                          {editStep ? "Edit step" : "Add a step"}
                        </div>

                        <input
                            className="field"
                            placeholder="Step name (e.g. Develop concept)"
                            value={stepName}
                            onChange={(event) => setStepName(event.target.value)}
                        />

                        <textarea
                            className="field prompt-field"
                            placeholder={
                              "Write the instruction for the AI...\n\nExample: Turn {{input}} into a concise creative brief."
                            }
                            value={template}
                            onChange={(event) => setTemplate(event.target.value)}
                        />

                        <div className="form-actions">
                          {editStep && (
                              <button
                                  className="btn btn-secondary"
                                  onClick={() => {
                                    setEditStep("");
                                    setStepName("");
                                    setTemplate("");
                                  }}
                              >
                                Cancel edit
                              </button>
                          )}

                          <button
                              className="btn btn-primary"
                              disabled={busy || !stepName.trim() || !template.trim()}
                              onClick={saveStep}
                          >
                            {editStep ? "Update step" : "＋ Add step"}
                          </button>
                        </div>
                      </div>

                      <div className="run-card">
                        <div className="run-heading">
                          <div>
                            <div className="eyebrow">RUN</div>
                            <h3>Run this chain</h3>

                            <p className="muted">
                              Add an image and/or some text. Enabled steps run one
                              after another, then you choose what to turn into media.
                            </p>
                          </div>
                        </div>

                        <details className="settings-panel">
                          <summary>
                      <span className="settings-title">
                        Models &amp; creativity
                      </span>
                            <span className="settings-summary">
                        {modelLabel(settings.textModel, "text")} →{" "}
                              {modelLabel(settings.imageModel, "image")}
                              {settings.fallback ? " · auto-switch on" : ""}
                      </span>
                          </summary>

                          <div className="settings-grid">
                            <ModelSelect
                                label="Text model (chain steps)"
                                kind="text"
                                value={settings.textModel}
                                providers={providers}
                                disabled={busy}
                                onChange={(ref) => updateSettings({ textModel: ref })}
                            />

                            <ModelSelect
                                label="Image model (media)"
                                kind="image"
                                value={settings.imageModel}
                                providers={providers}
                                disabled={busy}
                                onChange={(ref) => updateSettings({ imageModel: ref })}
                            />

                            <div className="setting">
                              <label htmlFor="text-temp">
                                Text creativity{" "}
                                <b>{settings.textTemperature.toFixed(1)}</b>
                              </label>
                              <input
                                  id="text-temp"
                                  type="range"
                                  min={0}
                                  max={2}
                                  step={0.1}
                                  value={settings.textTemperature}
                                  disabled={busy}
                                  onChange={(event) =>
                                      updateSettings({
                                        textTemperature: Number(event.target.value),
                                      })
                                  }
                              />
                              <span className="setting-note">
                          Temperature. Lower is more predictable.
                        </span>
                            </div>

                            <div className="setting">
                              <label htmlFor="image-temp">
                                Image creativity{" "}
                                <b>{settings.imageTemperature.toFixed(1)}</b>
                              </label>
                              <input
                                  id="image-temp"
                                  type="range"
                                  min={0}
                                  max={2}
                                  step={0.1}
                                  value={settings.imageTemperature}
                                  disabled={busy}
                                  onChange={(event) =>
                                      updateSettings({
                                        imageTemperature: Number(event.target.value),
                                      })
                                  }
                              />
                              <span className="setting-note">
                          Only used by Gemini image models.
                        </span>
                            </div>

                            <label className="setting check">
                              <input
                                  type="checkbox"
                                  checked={settings.fallback}
                                  disabled={busy}
                                  onChange={(event) =>
                                      updateSettings({ fallback: event.target.checked })
                                  }
                              />
                              <span>
                          <b>Auto-switch model</b>
                          <small>
                            If a model is overloaded or out of quota, try the
                            next one (any provider with a key).
                          </small>
                        </span>
                            </label>

                            <label className="setting check">
                              <input
                                  type="checkbox"
                                  checked={settings.review}
                                  disabled={busy}
                                  onChange={(event) =>
                                      updateSettings({ review: event.target.checked })
                                  }
                              />
                              <span>
                          <b>Let me choose before generating media</b>
                          <small>
                            Opens a window with the results so you can pick or
                            edit one.
                          </small>
                        </span>
                            </label>
                          </div>

                          {providers && (
                              <div className="provider-row">
                                {PROVIDERS.map((provider) => (
                                    <span
                                        key={provider}
                                        className={
                                          providers[provider]
                                              ? "provider-pill on"
                                              : "provider-pill"
                                        }
                                        title={
                                          providers[provider]
                                              ? "Key found"
                                              : `Add ${PROVIDER_ENV[provider]} to .env`
                                        }
                                    >
                            {providers[provider] ? "●" : "○"}{" "}
                                      {PROVIDER_LABELS[provider].split(" · ")[0]}
                          </span>
                                ))}
                              </div>
                          )}

                          {groqMissing && (
                              <p className="setting-note">
                                Hitting Gemini limits? Add a free GROQ_API_KEY
                                (console.groq.com) and Groq models become available here
                                and as automatic backups.
                              </p>
                          )}
                        </details>

                        <label htmlFor="chain-image-input" className="upload-drop">
                          <strong>
                            {imageFile
                                ? "Change image"
                                : "Upload an image (optional)"}
                          </strong>
                          <span>JPG, PNG or WebP · up to 10 MB</span>
                        </label>

                        <input
                            id="chain-image-input"
                            className="visually-hidden"
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={handleImageChange}
                            disabled={busy}
                        />

                        {imagePreview && (
                            <div className="upload-preview">
                              <img src={imagePreview} alt="Selected upload preview" />

                              <div>
                                <p>{imageFile?.name}</p>

                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={removeImage}
                                    disabled={busy}
                                >
                                  Remove image
                                </button>
                              </div>
                            </div>
                        )}

                        <textarea
                            className="field"
                            placeholder="Optional text instructions or context..."
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            disabled={busy}
                        />

                        <button
                            className="btn btn-run"
                            disabled={
                                busy ||
                                !steps.some((step) => step.enabled) ||
                                (!input.trim() && !imageFile)
                            }
                            onClick={execute}
                        >
                          {busy
                              ? "Working…"
                              : settings.review
                                  ? "✦ Run chain"
                                  : "✦ Run chain and generate media"}
                        </button>

                        {run && (
                            <RunProgress
                                run={run}
                                busy={busy}
                                onRetry={() => runFrom(run, run.outputs.length)}
                                onDismiss={() => setRun(null)}
                            />
                        )}

                        {generated && (
                            <div className="generated-result">
                              <img src={generated.url} alt="Generated result" />

                              <div>
                                <b>Generated successfully</b>
                                {generated.model && (
                                    <span className="model-tag">{generated.model}</span>
                                )}
                                <p>{generated.prompt}</p>
                              </div>
                            </div>
                        )}
                      </div>
                    </>
                ) : (
                    <div className="empty-state large">
                      <div className="empty-icon">✳</div>
                      <b>Select or create a prompt chain</b>
                      <span>Your creative workflows will appear here.</span>
                    </div>
                )}
              </section>
            </div>
        ) : (
            <>
              <div className="media-filter-row">
                <label htmlFor="media-filter">Filter by chain</label>

                <select
                    id="media-filter"
                    className="theme-select"
                    value={mediaFilter}
                    onChange={(event) => setMediaFilter(event.target.value)}
                >
                  <option value="all">All chains</option>

                  {chains.map((chain) => (
                      <option key={chain.id} value={chain.id}>
                        {chain.name}
                      </option>
                  ))}
                </select>
              </div>

              <section className="media-grid">
                {filteredMedia.map((item) => (
                    <MediaCard key={item.id} item={item} />
                ))}

                {!filteredMedia.length && (
                    <div className="empty-state large">
                      <div className="empty-icon">▧</div>
                      <b>No generated media yet</b>
                      <span>Run a prompt chain to see your creations here.</span>
                    </div>
                )}
              </section>
            </>
        )}

        <footer className="footer">
          <span>NYC UNHINGED · PROMPT CHAIN TOOL</span>
          <span>Built for creative operations</span>
        </footer>

        {review && (
            <div
                className="modal-backdrop"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !busy) setReview(null);
                }}
            >
              <div
                  className="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="modal-title"
              >
                <div className="modal-head">
                  <div>
                    <div className="eyebrow">
                      CHAIN FINISHED · {review.outputs.length} STEPS
                    </div>
                    <h3 id="modal-title">
                      {review.mode === "options"
                          ? `Pick one of ${review.options.length}`
                          : "Review the result"}
                    </h3>
                    <p className="muted">
                      {review.mode === "options"
                          ? "The last step produced a numbered list. Choose the one to turn into media."
                          : "This is the final output of your chain. Edit it if you like, then generate."}
                    </p>
                  </div>

                  <button
                      className="icon-btn"
                      disabled={busy}
                      onClick={() => setReview(null)}
                      aria-label="Close"
                  >
                    ×
                  </button>
                </div>

                <div className="modal-body">
                  {review.options.length >= 2 && (
                      <div className="modal-row">
                        <span className="modal-label">Treat the output as</span>
                        <Segmented
                            value={review.mode}
                            disabled={busy}
                            onChange={(mode) =>
                                updateReview({
                                  mode,
                                  choice: mode === "options" ? 0 : -1,
                                })
                            }
                            options={[
                              {
                                value: "options",
                                label: `${review.options.length} options`,
                              },
                              { value: "single", label: "One prompt" },
                            ]}
                        />
                      </div>
                  )}

                  {imagePreview && (
                      <div className="modal-ref">
                        <img src={imagePreview} alt="Your uploaded image" />
                        <span className="muted">Your uploaded image</span>
                      </div>
                  )}

                  {review.mode === "options" && (
                      <div
                          className="option-grid"
                          role="radiogroup"
                          aria-label="Options"
                      >
                        {review.options.map((option, index) => (
                            <label
                                key={index}
                                className={`option-card ${review.choice === index ? "selected" : ""}`}
                            >
                              <input
                                  type="radio"
                                  name="chain-option"
                                  className="visually-hidden"
                                  checked={review.choice === index}
                                  disabled={busy}
                                  onChange={() => updateReview({ choice: index })}
                              />
                              <span className="option-num">
                        {review.choice === index ? "✓" : index + 1}
                      </span>
                              <span className="option-text">{option}</span>
                            </label>
                        ))}
                      </div>
                  )}

                  <div className="modal-section">
                    <div className="modal-row">
                      <span className="modal-label">Use it as</span>
                      <Segmented
                          value={review.intent}
                          disabled={busy}
                          onChange={(intent) => updateReview({ intent })}
                          options={[
                            { value: "concept", label: "The image idea" },
                            {
                              value: "caption",
                              label: "A text caption on the image",
                            },
                          ]}
                      />
                    </div>

                    <label className="modal-label" htmlFor="final-prompt">
                      Prompt sent to the image model
                    </label>
                    <textarea
                        id="final-prompt"
                        className="field"
                        rows={review.mode === "options" ? 3 : 7}
                        value={review.promptText}
                        disabled={busy}
                        onChange={(event) =>
                            updateReview({ promptText: event.target.value })
                        }
                    />
                    <span className="setting-note">
                  {review.promptText.length.toLocaleString()} characters ·
                  editable. Picking a different option rewrites this.
                </span>
                  </div>

                  <details className="modal-settings">
                    <summary>
                      Image settings · {modelLabel(settings.imageModel, "image")}
                    </summary>

                    <div className="settings-grid">
                      <ModelSelect
                          label="Image model"
                          kind="image"
                          value={settings.imageModel}
                          providers={providers}
                          disabled={busy}
                          onChange={(ref) => updateSettings({ imageModel: ref })}
                      />

                      <div className="setting">
                        <label htmlFor="modal-temp">
                          Creativity <b>{settings.imageTemperature.toFixed(1)}</b>
                        </label>
                        <input
                            id="modal-temp"
                            type="range"
                            min={0}
                            max={2}
                            step={0.1}
                            value={settings.imageTemperature}
                            disabled={busy}
                            onChange={(event) =>
                                updateSettings({
                                  imageTemperature: Number(event.target.value),
                                })
                            }
                        />
                      </div>

                      {review.image && (
                          <label className="setting check">
                            <input
                                type="checkbox"
                                checked={review.includeRef && refSupported}
                                disabled={busy || !refSupported}
                                onChange={(event) =>
                                    updateReview({ includeRef: event.target.checked })
                                }
                            />
                            <span>
                        <b>Send my uploaded image as a reference</b>
                        <small>
                          {refSupported
                              ? "The model can edit or restyle your photo."
                              : "This model only reads text, so your photo can't be used."}
                        </small>
                      </span>
                          </label>
                      )}

                      <label className="setting check">
                        <input
                            type="checkbox"
                            checked={settings.fallback}
                            disabled={busy}
                            onChange={(event) =>
                                updateSettings({ fallback: event.target.checked })
                            }
                        />
                        <span>
                      <b>Auto-switch model</b>
                      <small>
                        Try the next available image model if this one fails.
                      </small>
                    </span>
                      </label>
                    </div>
                  </details>

                  {reviewError && (
                      <div className="error-box">
                        <pre>{reviewError}</pre>
                      </div>
                  )}

                  <details className="modal-settings">
                    <summary>
                      Step-by-step results ({review.outputs.length})
                    </summary>

                    <div className="modal-steps">
                      {review.outputs.map((item, index) => (
                          <div key={`${index}-${item.step}`}>
                            <div className="progress-title">
                              <b>
                                {index + 1}. {item.step}
                              </b>
                              {item.model && (
                                  <span className="model-tag">{item.model}</span>
                              )}
                            </div>
                            <p>{item.output}</p>
                          </div>
                      ))}
                    </div>
                  </details>
                </div>

                <div className="modal-foot">
                  <button
                      className="btn btn-quiet"
                      disabled={busy}
                      onClick={() => {
                        setReview(null);
                        execute();
                      }}
                  >
                    ↻ Re-run steps
                  </button>

                  {review.image && (
                      <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => makeMeme(review)}
                      >
                        {busy ? "Working…" : "🖼 Save my photo with this caption"}
                      </button>
                  )}

                  <div className="modal-foot-right">
                    <button
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => copyText(selectedText(review))}
                    >
                      Copy text
                    </button>

                    <button
                        className="btn btn-primary"
                        disabled={busy || !review.promptText.trim()}
                        onClick={() => generateMedia(review)}
                    >
                      {busy ? "Generating…" : "✦ Generate a new image"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
        )}
      </main>
  );
}

function MediaCard({ item }: { item: Media }) {
  const url = item.url || "";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
      <>
        <article
            className="media-card"
            style={{ cursor: url ? "zoom-in" : "default" }}
            onClick={() => url && setOpen(true)}
        >
          {url ? (
              <img src={url} alt="Generated media" />
          ) : (
              <div className="media-placeholder">Loading preview…</div>
          )}

          <div className="media-meta">
            <b>{item.prompt}</b>
            <small>{new Date(item.created_at).toLocaleString()}</small>
          </div>
        </article>

        {open && (
            <div className="lightbox" onClick={() => setOpen(false)}>
              <div className="lightbox-inner" onClick={(event) => event.stopPropagation()}>
                <img src={url} alt="Generated media, full size" />

                <p>{item.prompt}</p>

                <div className="lightbox-actions">
                  <a className="btn btn-secondary" href={url} target="_blank" rel="noreferrer">
                    Open in new tab
                  </a>

                  <button className="btn btn-primary" onClick={() => setOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
        )}
      </>
  );
}
