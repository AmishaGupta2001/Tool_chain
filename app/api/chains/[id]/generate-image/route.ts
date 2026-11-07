import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";
import {
  AIError,
  buildModelList,
  clampTemperature,
  errorResponseBody,
  generateImage,
  parseInputImage,
  runWithFallback,
  statusFor,
} from "@/lib/ai";
import { supportsReference } from "@/lib/ai-models";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Turns the prompt you chose into an image. The uploaded image is sent as a
 * visual reference only to models that support it (Gemini); FLUX / SDXL get text only.
 */
export async function POST(request: Request, { params }: Ctx) {
  const auth = await requireApiSuperadmin();
  if (auth.response) return auth.response;

  const { id } = await params;

  let prompt = "";
  let reference;
  let models: string[];
  let temperature: number;

  try {
    const body = await request.json();
    prompt = String(body.prompt ?? "").trim();
    reference = parseInputImage(body.image);
    temperature = clampTemperature(body.temperature, 1);
    models = buildModelList(body.imageModel, "image", body.fallback !== false);
  } catch (e) {
    if (e instanceof AIError) return NextResponse.json({ error: e.message }, { status: e.status || 400 });
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!prompt) {
    return NextResponse.json({ error: "Choose or write a prompt before generating media." }, { status: 400 });
  }
  if (prompt.length > 8000) {
    return NextResponse.json({ error: "The prompt is too long (8,000 characters max)." }, { status: 400 });
  }

  const { data: chain, error: chainError } = await auth.supabase
    .from("prompt_chains")
    .select("id")
    .eq("id", id)
    .single();

  if (chainError || !chain) return NextResponse.json({ error: "Chain not found." }, { status: 404 });

  try {
    const { result, model, attempts } = await runWithFallback(models, (m) => {
      const useRef = Boolean(reference) && supportsReference(m);

            const isCloudflare = m.startsWith("cloudflare:");

      // FLUX / SDXL work best with one plain visual description and no request for text.
      const imagePrompt = isCloudflare
        ? `${prompt.replace(/\s+/g, " ")}. High quality, sharp focus, detailed, natural lighting, realistic. No text, no letters, no words, no captions, no watermark, no logos.`
        : `
Create a polished, visually compelling image based on the following brief.
${useRef ? "Use the attached image as the visual reference." : ""}

Brief:
${prompt}

Create the image itself. Do not respond with only a text description.
`;
      return generateImage(m, {
        prompt: imagePrompt,
        reference: useRef ? reference : undefined,
        temperature,
      });
    });

    return NextResponse.json({
      image: result,
      model,
      attempts,
      usedReference: Boolean(reference) && supportsReference(model),
      finalPrompt: prompt,
    });
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError((e as Error).message, 502);
    console.error("[Image generation error]", { status: err.status, message: err.message });
    return NextResponse.json(errorResponseBody(err), { status: statusFor(err) });
  }
}