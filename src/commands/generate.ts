import { randomUUID } from "node:crypto";
import { api, printApiError } from "../lib/api.js";
import { resolveApiUrl } from "../lib/config.js";
import { downloadOutputAtomic } from "../lib/download-output.js";
import { CLI_EXIT, CliCommandError } from "../lib/errors.js";

type GenerationStatus = {
  id: string;
  status: "PENDING" | "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  type: string;
  model: string | null;
  webUrl: string;
  creditsUsed: number | null;
  outputs: Array<{ url: string; permanent: boolean; format: string }>;
  failureReason: string | null;
  refund: {
    state: "NOT_APPLICABLE" | "REFUNDED" | "NOT_REFUNDED";
    credits: number;
    refundedAt: string | null;
  };
};

type GenerationAccepted = {
  id: string;
  status: string;
  queue: string;
  creditsCharged: number;
  model: string;
  modelSource: "default" | "requested";
  webUrl: string;
};

type GenerationFlags = {
  wait?: boolean;
  json?: boolean;
  apiUrl?: string;
  output?: string;
  waitTimeoutMs?: number;
};

const CONTRACT_VERSION = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonLine(value: unknown) {
  console.log(JSON.stringify(value));
}

function recovery(id: string) {
  return { command: `pixelo generations get ${id} --wait`, generation_id: id };
}

function acceptedEnvelope(created: GenerationAccepted, kind: string) {
  return {
    version: CONTRACT_VERSION,
    outcome: "accepted",
    generation: {
      id: created.id,
      kind,
      status: created.status,
      queue: created.queue,
      credits_charged: created.creditsCharged,
      model: created.model,
      model_source: created.modelSource,
      web_url: created.webUrl,
    },
    recovery: recovery(created.id),
  };
}

const STORAGE_KEY_PREFIXES = ["public/", "media/", "video-agent/", "timeline/"];

function normalizeOutputUrl(value: string, apiUrl?: string): string | null {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
    return null;
  } catch {
    const key = value.replace(/^\/+/, "");
    if (!STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return null;
    return `${resolveApiUrl(apiUrl)}/api/media?key=${encodeURIComponent(key)}`;
  }
}

function normalizeStatusOutputs(status: GenerationStatus, apiUrl?: string) {
  return {
    ...status,
    outputs: status.outputs.map((output) => ({
      ...output,
      url: normalizeOutputUrl(output.url, apiUrl),
    })),
  };
}

async function presentTerminalOrCurrent(status: GenerationStatus, flags: GenerationFlags): Promise<void> {
  const presentedStatus = normalizeStatusOutputs(status, flags.apiUrl);
  let savedTo: string | undefined;
  if (flags.output) {
    if (status.status !== "COMPLETED") {
      throw new CliCommandError("--output requires a completed generation; use it with --wait.", CLI_EXIT.OUTPUT);
    }
    if (presentedStatus.outputs.length !== 1) {
      throw new CliCommandError("--output requires exactly one generated media file.", CLI_EXIT.OUTPUT);
    }
    const outputUrl = presentedStatus.outputs[0].url;
    if (!outputUrl) {
      throw new CliCommandError(
        `The generation has no usable media URL. Open it in Pixelo: ${status.webUrl}`,
        CLI_EXIT.OUTPUT,
      );
    }
    savedTo = await downloadOutputAtomic({
      url: outputUrl,
      destination: flags.output,
      format: presentedStatus.outputs[0].format,
    });
  }

  const outcome = status.status === "COMPLETED"
    ? "completed"
    : status.status === "FAILED"
      ? "failed"
      : "in_progress";
  if (flags.json) {
    jsonLine({
      version: CONTRACT_VERSION,
      outcome,
      generation: presentedStatus,
      ...(savedTo ? { saved_to: savedTo } : {}),
      recovery: recovery(status.id),
    });
  } else if (status.status === "COMPLETED") {
    console.log(`✓ ${status.type.toLowerCase()} ready (${status.creditsUsed} credits)`);
    if (status.model) console.log(`  model: ${status.model}`);
    for (const output of presentedStatus.outputs) {
      if (output.url) {
        console.log(`  download: ${output.url}${output.permanent ? "" : "  (temporary link — save it now)"}`);
      }
    }
    console.log(`  view in Pixelo: ${status.webUrl}`);
    if (savedTo) console.log(`  saved atomically to ${savedTo}`);
  } else if (status.status === "FAILED") {
    const refund = status.refund.state === "REFUNDED"
      ? `${status.refund.credits} credits refunded`
      : "refund not confirmed; review the generation in Pixelo or contact support";
    console.error(`✗ generation ${status.id} failed${status.failureReason ? `: ${status.failureReason}` : ""} (${refund})`);
  } else {
    console.error(`… ${status.status.toLowerCase()} — ${recovery(status.id).command}`);
  }

  if (status.status === "FAILED") {
    throw new CliCommandError("Generation failed.", CLI_EXIT.GENERATION_FAILED, true);
  }
}

async function pollGeneration(id: string, flags: GenerationFlags): Promise<GenerationStatus> {
  const deadline = Date.now() + (flags.waitTimeoutMs ?? 10 * 60 * 1000);
  let delay = 2_000;
  let lastStatus: GenerationStatus | null = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = await api<GenerationStatus>(`/api/v1/generations/${id}`, { apiUrl: flags.apiUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (flags.json) {
        jsonLine({
          version: CONTRACT_VERSION,
          outcome: "polling_error",
          generation: { id, status: lastStatus?.status ?? "UNKNOWN" },
          error: { code: "POLLING_ERROR", message },
          recovery: recovery(id),
        });
      } else {
        console.error(`✗ polling failed for generation ${id}: ${message}`);
        console.error(`  recover with: ${recovery(id).command}`);
      }
      throw new CliCommandError("Generation polling failed.", CLI_EXIT.NETWORK_OR_POLL, true);
    }
    if (lastStatus.status === "COMPLETED" || lastStatus.status === "FAILED") return lastStatus;
    if (!flags.json) process.stderr.write(`\r  ${lastStatus.status.toLowerCase()}…   `);
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(10_000, Math.round(delay * 1.5));
  }
  if (!flags.json) process.stderr.write("\r");
  if (flags.json) {
    jsonLine({
      version: CONTRACT_VERSION,
      outcome: "timed_out",
      generation: { id, status: lastStatus?.status ?? "UNKNOWN" },
      recovery: recovery(id),
    });
  } else {
    console.error(`✗ timed out waiting for generation ${id}.`);
    console.error(`  recover with: ${recovery(id).command}`);
  }
  throw new CliCommandError("Generation wait timed out.", CLI_EXIT.TIMEOUT, true);
}

export async function getGeneration(id: string, flags: GenerationFlags): Promise<void> {
  try {
    const status = flags.wait
      ? await pollGeneration(id, flags)
      : await api<GenerationStatus>(`/api/v1/generations/${id}`, { apiUrl: flags.apiUrl });
    await presentTerminalOrCurrent(status, flags);
  } catch (error) {
    printApiError(error);
  }
}

export async function generate(
  kind: "image" | "video",
  prompt: string,
  flags: GenerationFlags & {
    model?: string;
    aspectRatio?: string;
    count?: number;
    duration?: number;
    negativePrompt?: string;
  },
): Promise<void> {
  try {
    const body: Record<string, unknown> = { kind, prompt };
    if (flags.model) body.model = flags.model;
    if (flags.aspectRatio) body.aspectRatio = flags.aspectRatio;
    if (kind === "image" && flags.count) body.count = flags.count;
    if (kind === "image" && flags.negativePrompt) body.negativePrompt = flags.negativePrompt;
    if (kind === "video" && flags.duration) body.duration = flags.duration;

    const operationKey = randomUUID();
    const created = await api<GenerationAccepted>(
      "/api/v1/generations",
      {
        method: "POST",
        body,
        apiUrl: flags.apiUrl,
        idempotencyKey: operationKey,
      },
    );

    if (flags.json) {
      jsonLine(acceptedEnvelope(created, kind));
    } else {
      console.error(
        `✓ queued ${kind} ${created.id} (${created.creditsCharged} credits` +
          `${created.queue === "SLOW" ? ", slow queue" : ""})`,
      );
      console.error(`  model: ${created.model}${created.modelSource === "default" ? " (Pixelo default; override with --model)" : ""}`);
    }

    if (flags.wait || flags.output) {
      const status = await pollGeneration(created.id, flags);
      await presentTerminalOrCurrent(status, flags);
    } else if (!flags.json) {
      console.error(`  follow up with: ${recovery(created.id).command}`);
    }
  } catch (error) {
    printApiError(error);
  }
}

export { acceptedEnvelope, normalizeOutputUrl, pollGeneration };
