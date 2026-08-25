# pi-tva-toolbox

pi-tva-toolbox — Tree · Versions · Alternatives. Session-tree tools for
[pi](https://pi.dev), the terminal coding agent.

pi keeps every session as a tree of branches (`/tree`). These tools rewind, fan out,
forget, and move those branches: rewinding a session to its first message, forking one
point into several labeled branches, forgetting selected turns on the active branch, and
forking a branch into a different working directory.

Requires pi >= 0.84 and Node >= 22.19. Nothing leaves your machine: no extension in this
toolbox collects or sends telemetry, and none makes network requests.

Vocabulary: a *session tree* is the whole history of a session; a *branch* is one path
through it; the *active branch* is the one the model sees; a *turn* is one user message
and the reply to it; *rewind* moves the active branch back to an earlier point; *fork*
starts a new branch from a point.

## Extensions

| Extension | Trigger | What it does |
| --- | --- | --- |
| [pi-time-heist](extensions/pi-time-heist) | fork, then `/heist` | Fork a session from any point in its tree into a *different* working directory |
| [pi-fork-off](extensions/pi-fork-off) | `/fork-off` | Fork one point into several labeled branches, to explore in parallel |
| [pi-pluck](extensions/pi-pluck) | `/pluck` | Forget every turn matching a regex on the active branch (one note appended, nothing cloned or deleted); `/unpluck` restores |
| [pi-clear](extensions/pi-clear) | `/clear` | Rewind the session to its first user message as a new branch |

Two related tools, pi-pruner and pi-version-sentinel, are standalone extensions
maintained outside this repository and are not part of the umbrella.

## Install

The whole toolbox, one package:

```bash
pi install npm:pi-tva-toolbox
```

Or any extension on its own — each is published separately under `@arielsakin`:

```bash
pi install npm:@arielsakin/pi-time-heist
pi install npm:@arielsakin/pi-fork-off
pi install npm:@arielsakin/pi-pluck
pi install npm:@arielsakin/pi-clear
```

Or straight from git (the toolbox):

```bash
pi install git:github.com/asakin/pi-tva-toolbox
```

To load only some of the toolbox's extensions, use the object form in your settings:

```json
{
  "packages": [
    {
      "source": "npm:pi-tva-toolbox",
      "extensions": ["node_modules/@arielsakin/pi-time-heist/src/index.ts"]
    }
  ]
}
```

## Development

### Layout

This repo publishes **N+1 packages** from one monorepo: every tool under
`extensions/` is its own npm workspace and npm package (`@arielsakin/pi-*`), and the
root `pi-tva-toolbox` is an umbrella that depends on all of them, bundles them
(`bundleDependencies`), and points `pi.extensions` at
`node_modules/@arielsakin/<tool>/src/index.ts`. Shared internals live in `lib/`
(`@arielsakin/pi-tva-lib`, TypeScript source, a plain runtime dependency of
pi-time-heist).

Why an umbrella rather than one package: each tool stays installable and versionable
on its own, while `pi install npm:pi-tva-toolbox` gives the whole set in one step.
The pack test (`scripts/pack.test.mjs`) keeps the two in agreement by checking that
every `pi.extensions` path and every bundled package is inside the umbrella tarball.

In the checkout, `npm install` symlinks every workspace into `node_modules/`, so the
root's `node_modules/...` paths resolve to the live sources. Run it before the
path-install below.

### Local install

Do not symlink into `~/.pi/agent/extensions/`. Path-install the checkout so pi loads it
as a package (no copy; edits are live):

```bash
# from the repo root
pi install "$(pwd)"
pi list
```

pi stores the path relative to `~/.pi/agent/settings.json`, so `pi list` shows a
`../../...` line followed by the resolved absolute path. That is normal.

Then `/reload` in pi (or restart) so the listed extensions load.

To reset and redo:

```bash
pi remove "$(pwd)"
pi install "$(pwd)"
```

### Day-to-day

```bash
npm install
npm run check      # typecheck lib/ and every workspace
npm test           # node --test in every workspace, plus the pack test
```

Extensions are plain TypeScript, loaded by pi through jiti. There is no build step.

To ship a new tool: add the workspace under `extensions/`, add it to the root
`dependencies` + `bundleDependencies`, and append its entry path to the root
`pi.extensions` array.

### Release

All packages move in lockstep:

```bash
npm run version:set 1.1.0   # root, lib, every extension, and every internal pin
```

Commit, tag `v1.1.0`, publish a GitHub release for that tag.
`.github/workflows/publish.yml` checks the tag against the version, runs check + test,
then publishes the lib, each extension, and the umbrella via npm trusted publishing,
skipping any package whose version is already on the registry.

The first publish of every package is manual, because each package's trusted publisher
is configured in its own npmjs.com settings, which exist only once the package does:

1. `npm run check && npm test` must be green.
2. `npm publish -w lib` (`@arielsakin/pi-tva-lib` first; pi-time-heist depends on it).
3. `npm publish -w extensions/<tool>` for each extension.
4. `npm publish` at the root for the umbrella.
5. On npmjs.com, add the GitHub Actions trusted publisher (`publish.yml`) to each
   package's settings so the workflow can publish the next release.

## License

Apache 2.0
