# AGENTS.md

## Project State
This repository is a monorepo of Pi extensions for manipulating session files and
related agent tooling. Each extension is its own npm workspace under `extensions/`,
with its own `package.json`, `pi` manifest, and version.

## Rules for Agents Working Here
1. **State Over Aspiration**: Describe what is currently implemented, not what is planned.
2. **Companion Folder**: Drafts, notes, decision logs, and plans must be stored in the companion directory (`~/projects/oss/companions/pi-tva-toolbox`), out of the source tree.
3. **OSS Context**: This is a public open-source project. Contributors and their agents operate in various environments; ensure no proprietary corporate context, internal paths, or private credentials from any operator's workplace leak into this repository. Use only the contributor's public name, email, and GitHub handle for attribution.
4. **Working Product**: Every extension must remain loadable and functional via `/reload` at all times. Breakages must be reverted or fixed immediately.
5. **README Table Is the Index**: The extensions table in the root `README.md` lists every extension in `extensions/`. When you add, remove, or rename an extension, update that table in the same change — it must never drift from what is on disk.
