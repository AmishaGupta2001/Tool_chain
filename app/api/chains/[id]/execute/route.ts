import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";
import {
  AIError,
  buildModelList,
  clampTemperature,
  errorResponseBody,
  generateText,
  parseInputImage,
  runWithFallback,
  statusFor,
  stripMarkdown,
  visionOnly,
} from "@/lib/ai";

type Ctx = { params: Promise<{ id: string }> };

function renderTemplate(
    template: string,
    values: { input: string; previousOutput: string; chainName: string },
) {
  return template
      .replaceAll("{{input}}", values.input)
      .replaceAll("{{previous_output}}", values.previousOutput)
      .replaceAll("{{chain_name}}", values.chainName);
}

/**
 * Runs ONE step of a chain. The dashboard calls this once per step so it can
 * show live progress, keep finished steps if a later one fails, and retry only
 * the failed step (saving your quota).
 */
export async function POST(request: Request, { params }: Ctx) {
  const auth = await requireApiSuperadmin();
  if (auth.response) return auth.response;

  const { id } = await params;

  let stepId = "";
  let stepNumber = 1;
  let totalSteps = 1;
  let input = "";
  let previousOutput = "";
  let inputImage;
  let models: string[];
  let temperature: number;

  try {
    const body = await request.json();
    stepId = String(body.stepId ?? "");
    stepNumber = Math.max(1, Number(body.stepNumber) || 1);
    totalSteps = Math.max(stepNumber, Number(body.totalSteps) || stepNumber);
    input = String(body.input ?? "")
        .trim()
        .slice(0, 60_000);
    previousOutput = String(body.previousOutput ?? "").slice(0, 60_000);
    inputImage = parseInputImage(body.image);
    temperature = clampTemperature(body.temperature, 1);
    models = buildModelList(body.textModel, "text", body.fallback !== false);
  } catch (e) {
    if (e instanceof AIError)
      return NextResponse.json(
          { error: e.message },
          { status: e.status || 400 },
      );
    return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 },
    );
  }

  if (!stepId)
    return NextResponse.json({ error: "Missing step." }, { status: 400 });
  if (!input && !inputImage && stepNumber === 1) {
    return NextResponse.json(
        { error: "Enter some text or upload an image before running the chain." },
        { status: 400 },
    );
  }

  const { data: chain, error: chainError } = await auth.supabase
      .from("prompt_chains")
      .select("*")
      .eq("id", id)
      .single();

  if (chainError || !chain) {
    return NextResponse.json(
        { error: chainError?.message || "Chain not found." },
        { status: 404 },
    );
  }
  if (!chain.enabled) {
    return NextResponse.json(
        { error: "This chain is disabled. Enable it before running." },
        { status: 400 },
    );
  }

  const { data: step, error: stepError } = await auth.supabase
      .from("prompt_chain_steps")
      .select("*")
      .eq("id", stepId)
      .eq("chain_id", id)
      .single();

  if (stepError || !step)
    return NextResponse.json({ error: "Step not found." }, { status: 404 });
  if (!step.enabled)
    return NextResponse.json(
        { error: "This step is disabled." },
        { status: 400 },
    );

  // Steps that receive the image need a model that can read images.
  if (inputImage) {
    models = visionOnly(models);
    if (!models.length) {
      return NextResponse.json(
          {
            error:
                "None of the available models can read images. Pick a Gemini or Llama 4 Scout model, or remove the image.",
          },
          { status: 400 },
      );
    }
  }

  const prev = previousOutput || input || "Analyze the attached image.";

  const template = renderTemplate(String(step.prompt_template), {
    input: input || "See the attached image.",
    previousOutput: prev,
    chainName: String(chain.name),
  });

  const prompt = `
You are executing step ${stepNumber} of ${totalSteps} in a sequential prompt chain.

Chain: ${chain.name}
Step: ${step.name}

Original user input:
${input || "(The user supplied an image instead of text.)"}

${
      stepNumber === 1
          ? "Use the attached image as the primary input for this step, if an image was supplied."
          : `The actual output from the previous step is:\n${prev}`
  }

Instructions for this step:
${template}

Complete this step only.
Do not attempt to execute future steps.
Return the complete result as plain text.
`;

  try {
    const { result, model, attempts } = await runWithFallback(models, (m) =>
        generateText(m, { prompt, inputImage, temperature }),
    );

    return NextResponse.json({
      output: stripMarkdown(result),
      model,
      attempts,
    });
  } catch (e) {
    const err =
        e instanceof AIError ? e : new AIError((e as Error).message, 502);
    console.error("[Chain step error]", {
      step: step.name,
      status: err.status,
      message: err.message,
    });
    return NextResponse.json(errorResponseBody(err), {
      status: statusFor(err),
    });
  }
}
