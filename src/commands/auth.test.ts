import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLogout, browserCommand } from "./auth.js";
import { CliCommandError } from "../lib/errors.js";
import { loadCredential, saveCredential } from "../lib/token-store.js";

const ORIGIN = "https://api.pixelo.ai";
const originalFetch = globalThis.fetch;
let temporaryRoot = "";

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

describe("auth portability and revocation", () => {
  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "pixelo-cli-auth-command-"));
    process.env.XDG_CONFIG_HOME = temporaryRoot;
    process.env.PIXELO_DISABLE_KEYCHAIN = "1";
    delete process.env.PIXELO_TOKEN;
    saveTestCredential();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.PIXELO_DISABLE_KEYCHAIN;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("uses argument-safe browser launch commands on macOS, Linux, and Windows", () => {
    const url = "https://pixelo.ai/device?user_code=ABCD1234&next=%20";
    expect(browserCommand("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(browserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    expect(browserCommand("win32", url)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  test("revokes the refresh credential before removing the local bundle", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${ORIGIN}/api/auth/device/revoke`);
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "pixelo-cli",
        refresh_token: "refresh-token",
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await authLogout(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadCredential(ORIGIN)).toBeNull();
  });

  test("removes local credentials but reports unconfirmed remote revocation when offline", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await authLogout(ORIGIN);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CliCommandError);
    expect((thrown as CliCommandError).exitCode).toBe(4);
    expect((thrown as Error).message).toContain("server revocation could not be confirmed");
    expect(loadCredential(ORIGIN)).toBeNull();
  });
});
