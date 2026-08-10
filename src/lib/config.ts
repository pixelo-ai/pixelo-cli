import packageMetadata from "../../package.json" with { type: "json" };

export const DEFAULT_API_URL = "https://api.pixelo.ai";

export function canonicalApiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Pixelo API URLs must use HTTPS (HTTP is allowed only for explicit loopback development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Pixelo API URLs cannot contain credentials, query parameters, or fragments.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Pixelo API URL must be an origin without a path.");
  }
  return url.origin;
}

export function resolveApiUrl(flag?: string): string {
  return canonicalApiOrigin(flag || process.env.PIXELO_API_URL || DEFAULT_API_URL);
}

export const CLI_CLIENT_ID = packageMetadata.pixelo.clientId;
export const CLI_VERSION = packageMetadata.version;
