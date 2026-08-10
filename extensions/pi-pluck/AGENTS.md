# AGENTS.md — pi-pluck

## Version control (jj)

This repo uses **Jujutsu (jj)**, colocated with git / GitHub. Agents must use jj for local history — not bare `git commit` / `git add`.

- Prefer `jj describe` / `jj commit` for each finished slice.
- Follow-up fixes and review edits are new changes on top of prior ones; do not rewrite history or force-push unless explicitly asked.
- `git` remains present for remotes and tooling; jj is the authoring surface.
- Do not push unless asked.

## Pi APIs

Prefer public exports from `@earendil-works/pi-coding-agent`. Session writes from a command context need a deliberate widen of `ReadonlySessionManager` to the live `SessionManager` (see `grow-forgetful-branch.ts`). Read Pi’s session-format / tree docs (and `pi-fork-off` in pi-tva-toolbox) before changing grow/label/leaf behavior.

## Tests

Failing repro first for tree/grow bugs. `bun test` uses a live `SessionManager` from the `pi` binary on PATH.
