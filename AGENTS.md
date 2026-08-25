# AGENTS.md

## Project State
This repository is a monorepo of pi extensions for session trees: branches, rewinds,
and forks. Each extension is its own npm workspace under `extensions/`, with its own
`package.json`, `pi` manifest, and version, published on its own under `@arielsakin`.
Shared internals live in the `lib/` workspace (`@arielsakin/pi-tva-lib`). The root
`pi-tva-toolbox` is an umbrella package that bundles all the extensions. Versions move
in lockstep via `npm run version:set`.

## Rules for Agents Working Here
1. **State over aspiration**: describe what is currently implemented, not what is planned.
2. **Public project**: this is an open-source repository. Do not commit proprietary context, internal paths, or credentials from any operator's environment. Attribution uses only the contributor's public name, email, and GitHub handle.
3. **Working product**: every extension must remain loadable via `/reload` at all times. Fix or revert a breakage in the same change.
4. **README table is the index**: the extensions table in the root `README.md` lists every extension in `extensions/`. When you add, remove, or rename an extension, update that table in the same change.
5. **Contribution workflow**: see `CONTRIBUTING.md`. Do not rewrite published history; do not push unless asked.
