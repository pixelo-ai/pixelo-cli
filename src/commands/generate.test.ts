import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, getGeneration } from "./generate.js";
import { CliCommandError } from "../lib/errors.js";
import { saveCredential } from "../lib/token-store.js";

const ORIGIN = "https://api.pixelo.ai";
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalWrite = process.stderr.write;
let temporaryRoot = "";
let stdout: string[] = [];
let stderr: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function saveTestCredential() {
  saveCredential({
    version: 1,
    api_origin: ORIGIN,
    access_token: "access-token",
    refresh_token: "refresh-token",
    access_expires_at: "2026-08-06T00:00:00.000Z",
    refresh_expires_at: "2026-09-06T00:00:00.000Z",
  });
}

function completedStatus() {
  return {
    id: "generation-1",
    status: "COMPLETED",
    type: "IMAGE",
    model: "google-nano-banana-2-lite",
    webUrl: "https://pixelo.ai/app/gen/generation-1",
    creditsUsed: 4,
    outputs: [{ url: "https://cdn.pixelo.ai/one.png", permanent: true, format: "png" }],
    failureReason: null,
    refund: { state: "NOT_APPLICABLE", credits: 0, refundedAt: null },
  };
}

const QUOTE = {
  quoteId: "quote-1",
  contractId: "contract-1",
  credits: 4,
  expiresAt: "2026-10-13T18:00:00.000Z",
  model: "google-nano-banana-2-lite",
};

const ACCEPTED = {
  id: "generation-1",
  status: "QUEUED",
  queue: "FAST",
  creditsCharged: 4,
  model: "google-nano-banana-2-lite",
  modelSource: "default",
  webUrl: "https://pixelo.ai/app/gen/generation-1",
};

type Call = { url: string; method: string; body: Record<string, unknown> | null; idempotencyKey: string | null };

function routedFetch(
  calls: Call[],
  routes: { quote?: () => Response; submit?: () => Response; status?: () => Response },
) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    if (url.endsWith("/api/v1/generation-quotes")) return (routes.quote ?? (() => jsonResponse(QUOTE)))();
    if (url.endsWith("/api/v1/generations")) return (routes.submit ?? (() => jsonResponse(ACCEPTED, 202)))();
    return (routes.status ?? (() => jsonResponse(completedStatus())))();
  }) as unknown as typeof fetch;
}

async function captureFailure(run: () => Promise<unknown>): Promise<CliCommandError> {
  try {
    await run();
  } catch (error) {
    return error as CliCommandError;
  }
  throw new Error("expected the command to fail");
}

describe("stable generation command contract", () => {
  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "pixelo-cli-generate-"));
    process.env.XDG_CONFIG_HOME = temporaryRoot;
    process.env.PIXELO_DISABLE_KEYCHAIN = "1";
    delete process.env.PIXELO_TOKEN;
    stdout = [];
    stderr = [];
    console.log = mock((...values: unknown[]) => stdout.push(values.map(String).join(" ")));
    console.error = mock((...values: unknown[]) => stderr.push(values.map(String).join(" ")));
    process.stderr.write = mock(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write) as unknown as typeof process.stderr.write;
    saveTestCredential();
    // The fallback warning is an implementation detail, not command output.
    stderr = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalWrite;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.PIXELO_DISABLE_KEYCHAIN;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("emits an accepted NDJSON envelope immediately with a recovery ID", async () => {
    globalThis.fetch = routedFetch([], {});

    await generate("image", "a fox", { json: true, apiUrl: ORIGIN });

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      version: 1,
      outcome: "accepted",
      idempotency_key: expect.any(String),
      generation: {
        id: "generation-1",
        kind: "image",
        status: "QUEUED",
        queue: "FAST",
        credits_charged: 4,
        model: "google-nano-banana-2-lite",
        model_source: "default",
        web_url: "https://pixelo.ai/app/gen/generation-1",
      },
      recovery: {
        command: "pixelo generations get generation-1 --wait",
        generation_id: "generation-1",
      },
    });
  });

  test("emits ordered accepted and completed envelopes when waiting", async () => {
    globalThis.fetch = routedFetch([], {});

    await generate("image", "a fox", { json: true, wait: true, apiUrl: ORIGIN });

    expect(stdout.map((line) => JSON.parse(line).outcome)).toEqual(["accepted", "completed"]);
    expect(JSON.parse(stdout[1]).generation.id).toBe("generation-1");
  });

  test("shows the resolved model, a usable media URL, and the Pixelo asset page", async () => {
    globalThis.fetch = routedFetch([], {
      status: () => jsonResponse({
        ...completedStatus(),
        outputs: [{ url: "media/user-1/one.png", permanent: true, format: "png" }],
      }),
    });

    await generate("image", "a fox", { wait: true, apiUrl: ORIGIN });

    const output = [...stderr, ...stdout].join("\n");
    expect(output).toContain("google-nano-banana-2-lite");
    expect(output).toContain("https://api.pixelo.ai/api/media?key=media%2Fuser-1%2Fone.png");
    expect(output).toContain("https://pixelo.ai/app/gen/generation-1");
    expect(output).not.toContain("\n  media/user-1/one.png");
  });

  test("reports only authoritative refund state and exits as generation failure", async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      ...completedStatus(),
      status: "FAILED",
      outputs: [],
      failureReason: "provider rejected request",
      refund: { state: "NOT_REFUNDED", credits: 0, refundedAt: null },
    })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await getGeneration("generation-1", { apiUrl: ORIGIN });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CliCommandError);
    expect((thrown as CliCommandError).exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("refund not confirmed");
    expect(stderr.join("\n")).not.toContain("credits refunded");
  });

  test("times out with the generation ID and deterministic recovery command", async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      ...completedStatus(),
      status: "PROCESSING",
      outputs: [],
    })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await getGeneration("generation-1", { json: true, wait: true, waitTimeoutMs: 1, apiUrl: ORIGIN });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as CliCommandError).exitCode).toBe(5);
    const terminal = JSON.parse(stdout.at(-1) || "{}");
    expect(terminal).toEqual(expect.objectContaining({
      version: 1,
      outcome: "timed_out",
      recovery: {
        command: "pixelo generations get generation-1 --wait",
        generation_id: "generation-1",
      },
    }));
  });

  test("preserves the ID and uses the polling exit code after a network loss", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await getGeneration("generation-1", { json: true, wait: true, waitTimeoutMs: 100, apiUrl: ORIGIN });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as CliCommandError).exitCode).toBe(4);
    const terminal = JSON.parse(stdout.at(-1) || "{}");
    expect(terminal.outcome).toBe("polling_error");
    expect(terminal.recovery.generation_id).toBe("generation-1");
  });

  test("quotes the exact request and submits it with the quote", async () => {
    const calls: Call[] = [];
    globalThis.fetch = routedFetch(calls, {
      quote: () => jsonResponse({ ...QUOTE, model: "fal-nano-banana-2", credits: 10 }),
    });

    await generate("image", "a fox", {
      json: true,
      apiUrl: ORIGIN,
      model: "fal-nano-banana-2",
      aspectRatio: "4:5",
      count: 1,
    });

    expect(calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/api/v1/generation-quotes`,
      `${ORIGIN}/api/v1/generations`,
    ]);
    const request = { kind: "image", prompt: "a fox", model: "fal-nano-banana-2", aspectRatio: "4:5", count: 1 };
    expect(calls[0].body).toEqual(request);
    expect(calls[1].body).toEqual({ ...request, quoteId: "quote-1" });
    expect(calls[1].idempotencyKey).toBeTruthy();
    expect(JSON.parse(stdout[0]).outcome).toBe("accepted");
  });

  test("submits the model the quote resolved when --model is omitted", async () => {
    const calls: Call[] = [];
    globalThis.fetch = routedFetch(calls, {});

    await generate("image", "a fox", { json: true, apiUrl: ORIGIN });

    expect(calls[0].body).toEqual({ kind: "image", prompt: "a fox" });
    expect(calls[1].body).toEqual({
      kind: "image",
      prompt: "a fox",
      model: "google-nano-banana-2-lite",
      quoteId: "quote-1",
    });
  });

  test("refuses a quote above --max-credits without submitting", async () => {
    const calls: Call[] = [];
    globalThis.fetch = routedFetch(calls, { quote: () => jsonResponse({ ...QUOTE, credits: 90 }) });

    const failure = await captureFailure(() =>
      generate("video", "a fox", { json: true, apiUrl: ORIGIN, maxCredits: 50 }),
    );

    expect(failure.exitCode).toBe(2);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(expect.objectContaining({
      outcome: "rejected",
      submitted: false,
      error: expect.objectContaining({ code: "QUOTE_OVER_BUDGET" }),
      quote: expect.objectContaining({ credits: 90 }),
    }));
  });

  test("sends a caller-supplied idempotency key", async () => {
    const calls: Call[] = [];
    globalThis.fetch = routedFetch(calls, {});

    await generate("image", "a fox", { json: true, apiUrl: ORIGIN, idempotencyKey: "n8n-run-42" });

    expect(calls[1].idempotencyKey).toBe("n8n-run-42");
    expect(JSON.parse(stdout[0]).idempotency_key).toBe("n8n-run-42");
  });

  test("reports a server rejection as definitive with its code", async () => {
    globalThis.fetch = routedFetch([], {
      submit: () => jsonResponse({ error: "This quote expired; refresh before generating", code: "QUOTE_EXPIRED" }, 409),
    });

    const failure = await captureFailure(() => generate("image", "a fox", { json: true, apiUrl: ORIGIN }));

    expect(failure.exitCode).toBe(2);
    expect(JSON.parse(stdout[0])).toEqual(expect.objectContaining({
      outcome: "rejected",
      submitted: false,
      error: expect.objectContaining({ code: "QUOTE_EXPIRED", status: 409 }),
    }));
  });

  test("reports a lost submission as uncertain with the key needed to recover it", async () => {
    globalThis.fetch = routedFetch([], {
      submit: () => {
        throw new TypeError("socket hang up");
      },
    });

    const failure = await captureFailure(() =>
      generate("image", "a fox", { json: true, apiUrl: ORIGIN, idempotencyKey: "n8n-run-43" }),
    );

    expect(failure.exitCode).toBe(4);
    const envelope = JSON.parse(stdout[0]);
    expect(envelope.outcome).toBe("uncertain");
    expect(envelope.idempotency_key).toBe("n8n-run-43");
    expect(envelope.recovery.hint).toContain("--idempotency-key n8n-run-43");
  });
});
