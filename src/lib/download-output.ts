import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { CLI_EXIT, CliCommandError } from "./errors.js";

const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

function extensionFor(contentType: string, format: string): string {
  const normalized = format.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized) return normalized === "jpeg" ? ".jpg" : `.${normalized}`;
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("webm")) return ".webm";
  return "";
}

export async function downloadOutputAtomic(input: {
  url: string;
  destination: string;
  format: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<string> {
  const url = new URL(input.url);
  if (!isSafeOutputUrl(url)) {
    throw new CliCommandError("Output URL is not HTTPS.", CLI_EXIT.OUTPUT);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    clearTimeout(timer);
    throw new CliCommandError(
      `Output download failed: ${error instanceof Error ? error.message : String(error)}`,
      CLI_EXIT.OUTPUT,
    );
  }
  if (!isSafeOutputUrl(new URL(response.url || url.toString()))) {
    clearTimeout(timer);
    throw new CliCommandError("Output download redirected to a non-HTTPS URL.", CLI_EXIT.OUTPUT);
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok) {
    clearTimeout(timer);
    throw new CliCommandError(`Output download failed (${response.status}).`, CLI_EXIT.OUTPUT);
  }
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    clearTimeout(timer);
    throw new CliCommandError(`Unexpected output content type: ${contentType || "missing"}.`, CLI_EXIT.OUTPUT);
  }
  const maxBytes = input.maxBytes ?? MAX_OUTPUT_BYTES;
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    clearTimeout(timer);
    throw new CliCommandError(`Output exceeds the ${maxBytes}-byte size limit.`, CLI_EXIT.OUTPUT);
  }

  const destination = extname(input.destination)
    ? input.destination
    : `${input.destination}${extensionFor(contentType, input.format)}`;
  if (existsSync(destination)) {
    clearTimeout(timer);
    throw new CliCommandError(`Refusing to overwrite existing output: ${destination}`, CLI_EXIT.OUTPUT);
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  let written = 0;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    if (!response.body) throw new Error("Output response had no body");
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      written += chunk.value.byteLength;
      if (written > maxBytes) throw new Error(`Output exceeds the ${maxBytes}-byte size limit`);
      writeSync(descriptor, chunk.value);
    }
    if (declaredLength > 0 && written !== declaredLength) {
      throw new Error(`Output was truncated (expected ${declaredLength} bytes, received ${written})`);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    const directoryDescriptor = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return destination;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw new CliCommandError(
      `Output was not saved: ${error instanceof Error ? error.message : String(error)}`,
      CLI_EXIT.OUTPUT,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isSafeOutputUrl(url: URL): boolean {
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}
