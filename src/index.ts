import { CLI_VERSION } from "./lib/config.js";
import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { generate, getGeneration } from "./commands/generate.js";
import { listModels } from "./commands/models.js";
import { api, printApiError } from "./lib/api.js";
import { CLI_EXIT, CliCommandError } from "./lib/errors.js";

const HELP = `pixelo — generate images and videos from your terminal

Usage:
  pixelo auth login                       Sign in via device code (opens browser)
  pixelo auth status                      Show the signed-in account and balance
  pixelo auth logout                      Remove stored credentials
  pixelo models list [--type image|video] List model IDs and the current default
  pixelo generate image "<prompt>"        Generate an image
      [--model <id>] [--aspect-ratio 1:1] [--count N] [--negative-prompt "..."] [--wait] [--output <path>]
  pixelo generate video "<prompt>"        Generate a video
      [--model <id>] [--aspect-ratio 16:9] [--duration 5] [--wait] [--output <path>]
  pixelo generations get <id> [--wait]    Check a generation's status
  pixelo account                          Show credits and billing context

Generation flags:
  --max-credits N          Refuse to submit if the quoted price is above N credits
  --idempotency-key <key>  Reuse after an uncertain submission to recover it
                           without a second charge (8-128 URL-safe characters)

Global flags:
  --json          Machine-readable output
  --api-url <url> Override the API origin (or set PIXELO_API_URL)
  --version, --help

Omit --model to use the default marked by "pixelo models list". The resolved
model is always reported; pass --model <id> for reproducible selection.

Requires a paid Pixelo plan. Manage connected devices at pixelo.ai/app/settings/connected-apps.`;

type Flags = Record<string, string | number | boolean>;

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = /^\d+$/.test(next) ? Number(next) : next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command, subcommand, ...rest] = positional;
  const apiUrl = typeof flags["api-url"] === "string" ? (flags["api-url"] as string) : undefined;
  const json = flags.json === true;

  if (flags.version) {
    console.log(CLI_VERSION);
    return;
  }

  switch (command) {
    case "auth":
      if (subcommand === "login") return authLogin(apiUrl);
      if (subcommand === "status") return authStatus(apiUrl);
      if (subcommand === "logout") return authLogout(apiUrl);
      break;
    case "models":
      if (subcommand === "list" || subcommand === undefined) {
        return listModels({ type: flags.type as string | undefined, json, apiUrl });
      }
      break;
    case "generate": {
      const prompt = rest.join(" ").trim();
      if ((subcommand === "image" || subcommand === "video") && prompt) {
        return generate(subcommand, prompt, {
          model: flags.model as string | undefined,
          aspectRatio: flags["aspect-ratio"] as string | undefined,
          count: typeof flags.count === "number" ? flags.count : undefined,
          duration: typeof flags.duration === "number" ? flags.duration : undefined,
          negativePrompt: flags["negative-prompt"] as string | undefined,
          maxCredits: typeof flags["max-credits"] === "number" ? flags["max-credits"] : undefined,
          idempotencyKey: flags["idempotency-key"] !== undefined && flags["idempotency-key"] !== true
            ? String(flags["idempotency-key"])
            : undefined,
          wait: flags.wait === true,
          json,
          apiUrl,
          output: flags.output as string | undefined,
        });
      }
      throw new CliCommandError('Usage: pixelo generate image|video "<prompt>" [flags]', CLI_EXIT.USAGE_OR_POLICY);
    }
    case "generations":
      if (subcommand === "get" && rest[0]) {
        return getGeneration(rest[0], {
          wait: flags.wait === true,
          json,
          apiUrl,
          output: flags.output as string | undefined,
        });
      }
      break;
    case "account":
      try {
        const me = await api("/api/v1/me", { apiUrl });
        console.log(JSON.stringify(me, null, 2));
      } catch (error) {
        printApiError(error);
      }
      return;
    default:
      break;
  }

  console.log(HELP);
  if (command) throw new CliCommandError(`Unknown command: ${command}`, CLI_EXIT.USAGE_OR_POLICY);
}

main().catch((error) => {
  const commandError = error instanceof CliCommandError
    ? error
    : new CliCommandError(error instanceof Error ? error.message : String(error), CLI_EXIT.NETWORK_OR_POLL);
  if (!commandError.reported) console.error(`✗ ${commandError.message}`);
  process.exitCode = commandError.exitCode;
});
