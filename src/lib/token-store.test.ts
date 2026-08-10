import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CredentialStoreError,
  clearCredential,
  credentialFilePath,
  loadCredential,
  saveCredential,
  type StoredCredential,
} from "./token-store.js";

const ORIGIN = "https://api.pixelo.ai";
let temporaryRoot = "";

function credential(origin = ORIGIN): StoredCredential {
  return {
    version: 1,
    api_origin: origin,
    access_token: "access-token",
    refresh_token: "refresh-token",
    access_expires_at: "2026-08-06T00:00:00.000Z",
    refresh_expires_at: "2026-09-06T00:00:00.000Z",
  };
}

describe("credential fallback store", () => {
  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "pixelo-cli-auth-"));
    process.env.XDG_CONFIG_HOME = temporaryRoot;
    process.env.PIXELO_DISABLE_KEYCHAIN = "1";
    delete process.env.PIXELO_TOKEN;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.PIXELO_DISABLE_KEYCHAIN;
    delete process.env.PIXELO_TOKEN;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("writes an origin-bound bundle atomically with owner-only permissions", () => {
    saveCredential(credential());

    const file = credentialFilePath();
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(loadCredential(ORIGIN)).toEqual(credential());
  });

  test("repairs a broadly-readable credential file before returning it", () => {
    saveCredential(credential());
    chmodSync(credentialFilePath(), 0o644);

    expect(loadCredential(ORIGIN)?.access_token).toBe("access-token");
    expect(lstatSync(credentialFilePath()).mode & 0o777).toBe(0o600);
  });

  test("refuses symlinks and credentials bound to another origin", () => {
    const file = credentialFilePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const target = join(temporaryRoot, "target.json");
    writeFileSync(target, JSON.stringify(credential()), { mode: 0o600 });
    symlinkSync(target, file);

    expect(() => loadCredential(ORIGIN)).toThrow(CredentialStoreError);
    rmSync(file);
    saveCredential(credential());
    expect(() => loadCredential("https://staging.pixelo.ai")).toThrow("refusing to send");
  });

  test("clears the local credential without touching unrelated files", () => {
    saveCredential(credential());
    const unrelated = join(dirname(credentialFilePath()), "keep.txt");
    writeFileSync(unrelated, "keep");

    clearCredential();

    expect(() => lstatSync(credentialFilePath())).toThrow();
    expect(lstatSync(unrelated).isFile()).toBe(true);
  });

  test("cleans the same-directory temporary file when the atomic rename fails", () => {
    const file = credentialFilePath();
    mkdirSync(file, { recursive: true, mode: 0o700 });

    expect(() => saveCredential(credential())).toThrow();
    expect(readdirSync(dirname(file)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
