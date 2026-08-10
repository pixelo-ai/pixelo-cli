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
    globalThis.fetch = mock(async () => jsonResponse({
      id: "generation-1",
      status: "QUEUED",
      queue: "FAST",
      creditsCharged: 4,
      model: "google-nano-banana-2-lite",
      modelSource: "default",
      webUrl: "https://pixelo.ai/app/gen/generation-1",
    })) as unknown as typeof fetch;

    await generate("image", "a fox", { json: true, apiUrl: ORIGIN });

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      version: 1,
      outcome: "accepted",
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
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/generations")) {
        return jsonResponse({
          id: "generation-1",
          status: "QUEUED",
          queue: "FAST",
          creditsCharged: 4,
          model: "google-nano-banana-2-lite",
          modelSource: "default",
          webUrl: "https://pixelo.ai/app/gen/generation-1",
        });
      }
      return jsonResponse(completedStatus());
    }) as unknown as typeof fetch;

    await generate("image", "a fox", { json: true, wait: true, apiUrl: ORIGIN });

    expect(stdout.map((line) => JSON.parse(line).outcome)).toEqual(["accepted", "completed"]);
    expect(JSON.parse(stdout[1]).generation.id).toBe("generation-1");
  });

  test("shows the resolved model, a usable media URL, and the Pixelo asset page", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/generations")) {
        return jsonResponse({
          id: "generation-1",
          status: "QUEUED",
          queue: "FAST",
          creditsCharged: 4,
          model: "google-nano-banana-2-lite",
          modelSource: "default",
          webUrl: "https://pixelo.ai/app/gen/generation-1",
        });
      }
      return jsonResponse({
        ...completedStatus(),
        outputs: [{ url: "media/user-1/one.png", permanent: true, format: "png" }],
      });
    }) as unknown as typeof fetch;

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
});
