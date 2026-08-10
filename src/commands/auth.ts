import { execFile } from "node:child_process";
import { platform } from "node:os";
import { CLI_CLIENT_ID, resolveApiUrl } from "../lib/config.js";
import { clearCredential, loadCredential, saveCredential } from "../lib/token-store.js";
import { api, ApiError, credentialFromTokenResponse, printApiError } from "../lib/api.js";
import { CLI_EXIT, CliCommandError } from "../lib/errors.js";

export function browserCommand(os: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (os === "darwin") return { command: "open", args: [url] };
  if (os === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const launch = browserCommand(platform(), url);
  execFile(launch.command, launch.args, () => {
    // Best effort. The verification URL and code are always printed.
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authLogin(apiUrl?: string): Promise<void> {
  const base = resolveApiUrl(apiUrl);
  try {
    const code = await api<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>("/api/auth/device/code", {
      method: "POST",
      body: { client_id: CLI_CLIENT_ID },
      apiUrl: base,
      auth: false,
    });

    console.log("");
    console.log("  To sign in, open the link below and confirm this code:");
    console.log("");
    console.log(`      ${code.user_code.replace(/(.{4})(.{4})/, "$1-$2")}`);
    console.log("");
    console.log(`  ${code.verification_uri_complete}`);
    console.log("");
    openBrowser(code.verification_uri_complete);

    let interval = (code.interval || 5) * 1000;
    const deadline = Date.now() + (code.expires_in || 600) * 1000;

    while (Date.now() < deadline) {
      await sleep(interval);
      let response: Response;
      try {
        response = await fetch(`${base}/api/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: code.device_code,
            client_id: CLI_CLIENT_ID,
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new CliCommandError(
          `Sign-in polling failed: ${error instanceof Error ? error.message : String(error)}`,
          CLI_EXIT.NETWORK_OR_POLL,
        );
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        const credential = credentialFromTokenResponse(base, body);
        if (!credential) {
          throw new CliCommandError("Sign-in returned an invalid credential bundle.", CLI_EXIT.AUTH);
        }
        saveCredential(credential);
        const me = await api<{ handle?: string; credits_available?: number; context?: string }>(
          "/api/v1/me",
          { apiUrl: base },
        ).catch(() => null);
        console.log(
          `✓ Signed in${me?.handle ? ` as @${me.handle}` : ""}` +
            (me ? ` (${me.credits_available} credits, ${me.context?.toLowerCase()} context)` : "."),
        );
        return;
      }

      switch (body.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval += 5000;
          continue;
        case "expired_token":
          throw new CliCommandError("The sign-in request expired. Run `pixelo auth login` again.", CLI_EXIT.AUTH);
        case "access_denied":
          throw new CliCommandError("Sign-in was denied.", CLI_EXIT.AUTH);
        default:
          throw new ApiError(response.status, body);
      }
    }

    throw new CliCommandError("Timed out waiting for device approval.", CLI_EXIT.TIMEOUT);
  } catch (error) {
    printApiError(error);
  }
}

export async function authStatus(apiUrl?: string): Promise<void> {
  const origin = resolveApiUrl(apiUrl);
  if (!loadCredential(origin)) {
    throw new CliCommandError("Not signed in. Run `pixelo auth login`.", CLI_EXIT.AUTH);
  }
  try {
    const me = await api<{ handle?: string; team?: string; plan?: string | null; credits_available: number; context: string }>(
      "/api/v1/me",
      { apiUrl: origin },
    );
    if (me.context === "TEAM") {
      console.log(`✓ Signed in — team "${me.team}" (${me.credits_available} credits)`);
    } else {
      console.log(`✓ Signed in as @${me.handle} — ${me.plan ?? "free"} plan, ${me.credits_available} credits`);
    }
  } catch (error) {
    printApiError(error);
  }
}

export async function authLogout(apiUrl?: string): Promise<void> {
  const origin = resolveApiUrl(apiUrl);
  const credential = loadCredential(origin);
  if (!credential) {
    console.log("Already signed out; no local credentials found.");
    return;
  }
  let revocationError: unknown = null;
  try {
    if (credential.refresh_token) {
      await api("/api/auth/device/revoke", {
        method: "POST",
        body: { client_id: CLI_CLIENT_ID, refresh_token: credential.refresh_token },
        apiUrl: origin,
        auth: false,
      });
    }
  } catch (error) {
    revocationError = error;
  } finally {
    clearCredential();
  }
  if (revocationError) {
    throw new CliCommandError(
      "Local credentials were removed, but server revocation could not be confirmed. Revoke the device in Settings → Connected Apps when online.",
      CLI_EXIT.NETWORK_OR_POLL,
    );
  }
  console.log("✓ Signed out; server credential revoked and local credentials removed.");
}
