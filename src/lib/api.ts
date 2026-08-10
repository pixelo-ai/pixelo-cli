import { clearCredential, loadCredential, saveCredential, type StoredCredential } from "./token-store.js";
import { CLI_CLIENT_ID, resolveApiUrl } from "./config.js";
import { CLI_EXIT, CliCommandError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `Request failed (${status})`,
    );
    this.name = "ApiError";
  }
}

export class ApiTransportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ApiTransportError";
  }
}

type ApiOptions = {
  method?: string;
  body?: unknown;
  apiUrl?: string;
  auth?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `Request timed out after ${timeoutMs}ms`
      : "Network request failed";
    throw new ApiTransportError(message, error);
  } finally {
    clearTimeout(timer);
  }
}

function credentialFromTokenResponse(
  origin: string,
  payload: Record<string, unknown>,
  now = Date.now(),
): StoredCredential | null {
  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    typeof payload.expires_in !== "number" ||
    typeof payload.refresh_expires_in !== "number"
  ) return null;
  return {
    version: 1,
    api_origin: origin,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    access_expires_at: new Date(now + payload.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + payload.refresh_expires_in * 1000).toISOString(),
  };
}

async function rotateCredential(origin: string, credential: StoredCredential, timeoutMs: number): Promise<StoredCredential | null> {
  if (!credential.refresh_token) return null;
  const response = await fetchWithTimeout(`${origin}/api/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      client_id: CLI_CLIENT_ID,
    }),
  }, timeoutMs);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) return null;
    throw new ApiTransportError(`Credential renewal failed (${response.status}); local credentials were retained.`);
  }
  const rotated = credentialFromTokenResponse(origin, payload);
  if (!rotated) {
    throw new ApiTransportError("Credential renewal returned an invalid bundle; local credentials were retained.");
  }
  saveCredential(rotated);
  return rotated;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = options;
  const origin = resolveApiUrl(options.apiUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const safeToRetry = method === "GET" || method === "HEAD" || Boolean(options.idempotencyKey);
  const maxRetries = options.maxRetries ?? (safeToRetry ? 2 : 0);
  let credential = auth ? loadCredential(origin) : null;
  if (auth && !credential) {
    throw new CliCommandError("Not signed in. Run `pixelo auth login` first.", CLI_EXIT.AUTH);
  }

  let refreshed = false;
  let attempt = 0;
  while (attempt <= maxRetries) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (credential) headers.Authorization = `Bearer ${credential.access_token}`;

    try {
      const response = await fetchWithTimeout(`${origin}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }, timeoutMs);
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.status === 401 && auth && credential && !refreshed) {
        refreshed = true;
        const rotated = await rotateCredential(origin, credential, timeoutMs);
        if (rotated) {
          credential = rotated;
          // Authentication recovery has its own one-shot budget and must not
          // consume the transport retry budget.
          continue;
        }
        clearCredential();
      }

      if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleep(100 * 2 ** attempt);
        attempt++;
        continue;
      }
      if (!response.ok) throw new ApiError(response.status, payload);
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError || error instanceof CliCommandError) throw error;
      if (attempt < maxRetries) {
        await sleep(100 * 2 ** attempt);
        attempt++;
        continue;
      }
      if (error instanceof ApiTransportError) throw error;
      throw new ApiTransportError("Network request failed", error);
    }
  }
  throw new ApiTransportError("Retry budget exhausted");
}

export function printApiError(error: unknown): never {
  if (error instanceof CliCommandError) throw error;
  if (error instanceof ApiError) {
    const { body } = error;
    if (body.reasonCode === "AGENT_ACCESS_REQUIRES_PAID") {
      const meta = body.meta as Record<string, unknown> | undefined;
      const suffix = meta?.upgradeUrl ? ` Upgrade: ${meta.upgradeUrl}` : "";
      throw new CliCommandError(`${body.message}${suffix}`, CLI_EXIT.USAGE_OR_POLICY);
    }
    if (body.reasonCode === "INSUFFICIENT_CREDITS" || body.reasonCode === "INSUFFICIENT_TEAM_CREDITS") {
      const meta = body.meta as Record<string, unknown> | undefined;
      throw new CliCommandError(
        `Not enough credits (need ${meta?.required}, have ${meta?.available}).`,
        CLI_EXIT.USAGE_OR_POLICY,
      );
    }
    if (error.status === 401) {
      throw new CliCommandError("Credential expired or revoked. Run `pixelo auth login` again.", CLI_EXIT.AUTH);
    }
    if (error.status === 429) {
      throw new CliCommandError(`Rate limited. Retry in ${body.retryAfter ?? "a few"} seconds.`, CLI_EXIT.USAGE_OR_POLICY);
    }
    throw new CliCommandError(`${error.message}${body.code ? ` (${body.code})` : ""}`, CLI_EXIT.USAGE_OR_POLICY);
  }
  if (error instanceof ApiTransportError) {
    throw new CliCommandError(error.message, CLI_EXIT.NETWORK_OR_POLL);
  }
  throw new CliCommandError(error instanceof Error ? error.message : String(error), CLI_EXIT.NETWORK_OR_POLL);
}

export { credentialFromTokenResponse };
