# Changelog

All notable changes to Pixelo CLI are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.2 - 2026-08-10

- Report the resolved requested or Pixelo-default model for queued and completed generations.
- Print directly usable media URLs and stable Pixelo library links instead of raw storage keys.
- Mark the current server default in `pixelo models list` and document exact `--model` selection.

## 0.1.1 - 2026-08-10

- Fix the npm package manifest so publication preserves the `pixelo` executable.

## 0.1.0 - 2026-08-10

- Add OAuth device sign-in with scoped, origin-bound credential storage.
- Add image and video generation, model discovery, generation polling, and account commands.
- Add stable JSON envelopes, exit codes, bounded retries, and atomic output downloads.
