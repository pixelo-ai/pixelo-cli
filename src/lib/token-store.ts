import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalApiOrigin } from "./config.js";

const KEYCHAIN_SERVICE = "ai.pixelo.cli";
const KEYCHAIN_ACCOUNT = "credentials-v1";

export type StoredCredential = {
  version: 1;
  api_origin: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
};

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export function credentialFilePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pixelo", "auth.json");
}

function keychainAvailable(): boolean {
  return platform() === "darwin" && process.env.PIXELO_DISABLE_KEYCHAIN !== "1";
}

function validateCredential(value: unknown): StoredCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.api_origin !== "string" ||
    typeof row.access_token !== "string" ||
    typeof row.refresh_token !== "string" ||
    typeof row.access_expires_at !== "string" ||
    typeof row.refresh_expires_at !== "string"
  ) return null;
  return {
    version: 1,
    api_origin: canonicalApiOrigin(row.api_origin),
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    access_expires_at: row.access_expires_at,
    refresh_expires_at: row.refresh_expires_at,
  };
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CredentialStoreError(`Credential directory is not a private regular directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new CredentialStoreError(`Credential directory is not owned by the current user: ${directory}`);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700);
}

function atomicWriteCredential(file: string, credential: StoredCredential): void {
  const directory = dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.auth.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
}

function readCredentialFile(file: string): StoredCredential | null {
  if (!existsSync(file)) return null;
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CredentialStoreError(`Refusing non-regular credential file: ${file}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new CredentialStoreError(`Credential file is not owned by the current user: ${file}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
  }
  try {
    return validateCredential(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError(`Credential file is invalid: ${file}`);
  }
}

function readKeychainCredential(): StoredCredential | null {
  if (!keychainAvailable()) return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    return validateCredential(JSON.parse(out.toString()));
  } catch {
    return null;
  }
}

export function saveCredential(credential: StoredCredential): void {
  const normalized = { ...credential, api_origin: canonicalApiOrigin(credential.api_origin) };
  if (keychainAvailable()) {
    try {
      execFileSync(
        "security",
        [
          "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE,
          "-a", KEYCHAIN_ACCOUNT, "-w", JSON.stringify(normalized),
        ],
        { stdio: "ignore" },
      );
      return;
    } catch {
      // Fall back loudly to the atomic owner-only file.
    }
  }
  const file = credentialFilePath();
  atomicWriteCredential(file, normalized);
  console.error(`warning: OS keychain unavailable — scoped credentials stored at ${file} (mode 600).`);
}

export function loadCredential(apiOrigin: string): StoredCredential | null {
  const requestedOrigin = canonicalApiOrigin(apiOrigin);
  if (process.env.PIXELO_TOKEN) {
    return {
      version: 1,
      api_origin: requestedOrigin,
      access_token: process.env.PIXELO_TOKEN,
      refresh_token: "",
      access_expires_at: new Date(8640000000000000).toISOString(),
      refresh_expires_at: new Date(8640000000000000).toISOString(),
    };
  }
  const credential = readKeychainCredential() ?? readCredentialFile(credentialFilePath());
  if (!credential) return null;
  if (credential.api_origin !== requestedOrigin) {
    throw new CredentialStoreError(
      `Stored credentials are bound to ${credential.api_origin}; refusing to send them to ${requestedOrigin}. Run auth login for that origin.`,
    );
  }
  return credential;
}

export function clearCredential(): void {
  if (keychainAvailable()) {
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
        { stdio: "ignore" },
      );
    } catch {
      // Nothing stored in the keychain.
    }
  }
  const file = credentialFilePath();
  if (existsSync(file)) rmSync(file, { force: true });
}
