# Pixelo CLI

Generate images and videos from a terminal using the same paid Pixelo account
and credit ledger as the web application.

## Install

After the first npm release is published:

```bash
npm install --global @pixelo-ai/cli
pixelo auth login
```

Until then, build the CLI from this repository with the development steps below.

## Commands

```bash
pixelo auth login
pixelo auth status
pixelo auth logout
pixelo models list --type image
pixelo generate image "a red fox in snow" --wait
pixelo generate video "waves at sunset" --duration 5 --wait
pixelo generations get <generation-id> --wait
pixelo account
```

`--output <path>` implies `--wait`, requires exactly one completed output, and
never overwrites an existing file. The download is validated and written by a
same-directory temporary file plus `fsync` and atomic rename. Add `--json` for
versioned newline-delimited JSON. A generation command writes an `accepted`
envelope containing its durable generation ID before it polls, followed by a
`completed`, `failed`, `timed_out`, or `polling_error` envelope where applicable.

Exit codes are stable:

| Code | Meaning |
|---:|---|
| `0` | Successful command or accepted asynchronous generation |
| `1` | Generation reached `FAILED` |
| `2` | Usage, validation, policy, credit, or rate denial |
| `3` | Missing, expired, or revoked authentication |
| `4` | Network, renewal, or polling failure |
| `5` | Device authorization or generation wait timed out |
| `6` | Output validation or persistence failure |

## Credential and retry contract

- Device login issues only the scoped agent credential. Access credentials
  rotate once through the refresh credential after a `401`.
- macOS uses Keychain when available. The fallback is an owner-only
  `${XDG_CONFIG_HOME:-~/.config}/pixelo/auth.json` bundle created atomically in
  an owner-only directory. `PIXELO_TOKEN` is an ephemeral CI override.
- A bundle is bound to one canonical HTTPS API origin. Plain HTTP is accepted
  only for explicit loopback development; `--api-url` cannot redirect a stored
  credential to another origin.
- Logout asks the server to revoke the refresh credential before deleting the
  local bundle. If the server is unavailable, local deletion still occurs and
  the CLI says that remote revocation is unconfirmed.
- Generation creates one operation idempotency key and reuses it for bounded
  retries after network loss or a retryable `502`, `503`, or `504`. Policy and
  validation failures are not retried.
- Refund wording comes only from durable server refund state. A failed
  generation without recorded refund evidence is reported as unconfirmed.

Manage OAuth and device access in Pixelo under Settings → Connected Apps.

## Development

```bash
bun install --frozen-lockfile
bun run dev -- auth status
bun test
bun run typecheck
bun run release:check
```

`release:check` runs typechecking, all tests, package metadata validation, a
fresh build, and an npm tarball dry-run. Generated `dist/`, `node_modules/`, and
package tarballs are intentionally untracked.

## Releasing

1. Update `version` in `package.json` and add the release to `CHANGELOG.md`.
2. Run `bun install --frozen-lockfile && bun run release:check`.
3. Merge the release commit to `main`.
4. Create a GitHub Release with tag `v<version>`.

Publishing the GitHub Release runs the npm workflow. The repository must have
an `npm` environment with an `NPM_TOKEN` secret authorized to publish
`@pixelo-ai/cli`. The workflow rejects a tag that does not exactly match the package
version and publishes with npm provenance.

## License

Copyright © 2026 Pixelo. No open-source license has been granted for this CLI;
the package metadata is intentionally marked `UNLICENSED`.
