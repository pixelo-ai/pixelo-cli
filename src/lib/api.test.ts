import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "./api.js";
import { loadCredential, saveCredential, type StoredCredential } from "./token-store.js";

const ORIGIN = "https://api.pixelo.ai";
const originalFetch = globalThis.fetch;
let temporaryRoot = "";

function credential(): StoredCredential {
  return {
    version: 1,
    api_origin: ORIGIN,
    access_token: "old-access",
    refresh_token: "old-refresh",
    access_expires_at: "2026-08-06T00:00:00.000Z",
    refresh_expires_at: "2026-09-06T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API transport", () => {
  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "pixelo-cli-api-"));
    process.env.XDG_CONFIG_HOME = temporaryRoot;
    process.env.PIXELO_DISABLE_KEYCHAIN = "1";
    delete process.env.PIXELO_TOKEN;
    saveCredential(credential());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.PIXELO_DISABLE_KEYCHAIN;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("retries a lost idempotent POST with the exact same operation key", async () => {
    const seenKeys: string[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("Idempotency-Key") || "");
      if (seenKeys.length === 1) throw new TypeError("socket reset after send");
      return jsonResponse({ id: "generation-1" });
    }) as unknown as typeof fetch;

    await expect(api("/api/v1/generations", {
      method: "POST",
      body: { prompt: "a fox" },
      idempotencyKey: "operation-1",
      maxRetries: 1,
    })).resolves.toEqual({ id: "generation-1" });
    expect(seenKeys).toEqual(["operation-1", "operation-1"]);
  });

  test("rotates once on 401 and retries even when transport retries are disabled", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      if (url.endsWith("/api/auth/device/token")) {
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 900,
          refresh_expires_in: 2_592_000,
        });
      }
      if (calls.filter((call) => call.url.endsWith("/resource")).length === 1) {
        return jsonResponse({ error: "expired" }, 401);
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await expect(api("/resource", { method: "POST", body: {}, maxRetries: 0 })).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer old-access", null, "Bearer new-access"]);
    expect(loadCredential(ORIGIN)).toEqual(expect.objectContaining({
      access_token: "new-access",
      refresh_token: "new-refresh",
    }));
  });

  test("origin mismatch fails before any request is sent", async () => {
    const fetchMock = mock(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(api("/resource", { apiUrl: "https://staging.pixelo.ai" })).rejects.toThrow("refusing to send");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
