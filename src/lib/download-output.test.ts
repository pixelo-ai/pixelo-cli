import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadOutputAtomic } from "./download-output.js";

const originalFetch = globalThis.fetch;
let temporaryRoot = "";

function mediaResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      ...headers,
    },
  });
}

describe("atomic output download", () => {
  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "pixelo-output-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("validates media and atomically selects an extension", async () => {
    globalThis.fetch = mock(async () => mediaResponse(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const destination = join(temporaryRoot, "result");

    const saved = await downloadOutputAtomic({
      url: "https://cdn.pixelo.ai/result",
      destination,
      format: "png",
    });

    expect(saved).toBe(`${destination}.png`);
    expect([...readFileSync(saved)]).toEqual([1, 2, 3]);
  });

  test("refuses overwrite without altering the existing file", async () => {
    const destination = join(temporaryRoot, "result.png");
    writeFileSync(destination, "original");
    globalThis.fetch = mock(async () => mediaResponse(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;

    await expect(downloadOutputAtomic({
      url: "https://cdn.pixelo.ai/result",
      destination,
      format: "png",
    })).rejects.toThrow("Refusing to overwrite");
    expect(readFileSync(destination, "utf8")).toBe("original");
  });

  test("rejects truncated bodies and removes temporary output", async () => {
    globalThis.fetch = mock(async () => mediaResponse(
      new Uint8Array([1, 2, 3]),
      { "Content-Length": "10" },
    )) as unknown as typeof fetch;
    const destination = join(temporaryRoot, "truncated.png");

    await expect(downloadOutputAtomic({
      url: "https://cdn.pixelo.ai/result",
      destination,
      format: "png",
    })).rejects.toThrow("truncated");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(temporaryRoot).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects insecure URLs and non-media content", async () => {
    await expect(downloadOutputAtomic({
      url: "http://cdn.pixelo.ai/result",
      destination: join(temporaryRoot, "bad"),
      format: "png",
    })).rejects.toThrow("not HTTPS");

    globalThis.fetch = mock(async () => new Response("html", {
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    await expect(downloadOutputAtomic({
      url: "https://cdn.pixelo.ai/result",
      destination: join(temporaryRoot, "bad"),
      format: "png",
    })).rejects.toThrow("Unexpected output content type");
  });
});
