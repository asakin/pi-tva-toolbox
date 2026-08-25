# Contributing

## Setup

```bash
git clone https://github.com/asakin/pi-tva-toolbox.git
cd pi-tva-toolbox
npm install
npm run check   # typecheck every workspace
npm test        # unit tests plus the umbrella pack test
```

To try your changes in pi, install the checkout as a local package and reload:

```bash
pi install "$(pwd)"
```

Then run `/reload` inside pi after each edit.

## Version control

Contribute with plain git: fork, branch, open a pull request. Do not rewrite history on a branch once it is under review; push follow-up commits instead.

## Layout

- `extensions/<name>/`: one npm workspace per extension, published as `@arielsakin/<name>`. Each keeps `src/index.ts` in its `files` list; the umbrella loads that path.
- `lib/`: `@arielsakin/pi-tva-lib`, shared internals. Not a pi package. It is a runtime dependency of pi-time-heist and must be published before any extension that depends on it (`publish.yml` orders it first).
- Root `package.json`: the `pi-tva-toolbox` umbrella. It lists every extension in `dependencies` (exact, lockstep version), `bundleDependencies`, and `pi.extensions` (`node_modules/@arielsakin/<name>/src/index.ts`). The pack test in `scripts/` checks that the tarball contains those files.

## Adding an extension

1. Create `extensions/<name>/` with `package.json` (name `@arielsakin/<name>`, current lockstep version, `files` including `src/index.ts`, a `pi` manifest), `src/index.ts`, `README.md` with an Install block, `LICENSE`, and `NOTICE`.
2. Add it to the root `dependencies`, `bundleDependencies`, and `pi.extensions`.
3. Add a row to the extensions table in the root `README.md`. That table must match `extensions/` on disk.
4. Add a line under `[Unreleased]` in `CHANGELOG.md`.
5. Run `npm install`, `npm run check`, and `npm test`.

## Releases

1. `npm run version:set X.Y.Z` bumps every workspace and the root pins together.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`.
3. Commit, tag `vX.Y.Z`, push the tag.
4. Publish a GitHub release for the tag with the changelog section as its notes. `publish.yml` publishes lib first, then the extensions, then the umbrella.

## Style

- Tabs in `.ts`, two spaces in JSON, YAML, and Markdown, LF line endings, final newline (`.editorconfig` enforces this).
- Comments state what the code does and, when it is not obvious, one line of why. No history, no instructions to future readers.
- Vocabulary in docs and messages: branch, active branch, session tree, rewind, fork.
- Attribution is your public name, email, and GitHub handle. Do not commit employer details, private paths, or credentials.
