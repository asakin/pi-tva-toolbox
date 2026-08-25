# pi-tva-toolbox

**TVA — Transcript Version Administration.** A collection of [Pi](https://pi.dev)
extensions for session trees, forks, and the versions they carry.

Pi sessions are append-only DAGs of JSON entries — a transcript and every branch of it.
These tools administer that graph: moving timelines between directories, rewinding a
session to its seed, growing side-branches that forget selected turns, pruning dead
branches, and checking the dependency versions written along the way.

## Extensions

| Extension | Trigger | What it does |
| --- | --- | --- |
| [pi-time-heist](extensions/pi-time-heist) | fork, then `/heist` | Fork a session from any point in its tree into a *different* working directory |
| [pi-fork-off](extensions/pi-fork-off) | `/fork-off` | Fork one point into several labeled branches, to explore in parallel |
| [pi-pluck](extensions/pi-pluck) | `/pluck` | Grow a labeled side-branch that forgets every turn matching a regex, leaving the trunk intact |
| [pi-pruner](extensions/pi-pruner) | `/prune` | Prune branches labeled `TVA-PRUNE` (and their descendants) from the session tree |
| [pi-clear](extensions/pi-clear) | `/clear` | Rewind the session to its first user message as a new branch |
| [pi-version-sentinel](extensions/pi-version-sentinel) | automatic | Catch a stale dependency version before it's written — a memory-refresh for autonomous agents |

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
pi install npm:@arielsakin/pi-pruner
pi install npm:@arielsakin/pi-clear
pi install npm:@arielsakin/pi-version-sentinel
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

This repo publishes **N+1 packages** from one monorepo: every tool under
`extensions/` is its own npm workspace and npm package (`@arielsakin/pi-*`), and the
root `pi-tva-toolbox` is an umbrella that depends on all of them, bundles them
(`bundleDependencies`), and points `pi.extensions` at
`node_modules/@arielsakin/<tool>/src/index.ts`. Shared internals live in `lib/`
(`@arielsakin/pi-tva-lib`, TypeScript source, a plain dependency of the tools that
use it). Mid-development tools stay unloaded until you append their entry path to the
root `pi.extensions` array and their package to `dependencies` + `bundleDependencies`.

In the checkout, `npm install` symlinks every workspace into `node_modules/`, so the
root's `node_modules/...` paths resolve to the live sources — run it before the
path-install below.

### Live against a local checkout

Do **not** drop symlinks into `~/.pi/agent/extensions/`. Path-install the repo so
pi loads it as a package (no copy; edits are live):

```bash
# from anywhere — use the absolute path to *this* checkout
pi install /Users/arielsakin/projects/OSS/pi-extensions/pi-tva-toolbox
pi list
```

What you should see in `pi list`:

```text
../../projects/OSS/pi-extensions/pi-tva-toolbox
  /Users/arielsakin/projects/OSS/pi-extensions/pi-tva-toolbox
```

pi rewrites the absolute path you passed into a path **relative to**
`~/.pi/agent/settings.json` (that `../../projects/...` line). That is normal —
not a manual settings edit. The resolved absolute path is the second line.

Then `/reload` in pi (or restart) so the listed extensions load.

To reset and redo:

```bash
pi remove /Users/arielsakin/projects/OSS/pi-extensions/pi-tva-toolbox
pi install /Users/arielsakin/projects/OSS/pi-extensions/pi-tva-toolbox
```

### Day-to-day

```bash
npm install
npm run check      # typecheck lib/ and every workspace
npm test           # node --test in every workspace
```

Extensions are plain TypeScript, loaded by pi through jiti. There is no build step.

To ship a new tool: add the workspace under `extensions/`, then, when it is ready to
load, add it to the root `dependencies` + `bundleDependencies` and append its entry
path to the root `pi.extensions` array.

`npm test` also packs the umbrella for real and checks that every `pi.extensions`
path and every bundled package is inside the tarball (`scripts/pack.test.mjs`).

### Release

All packages move in lockstep:

```bash
npm run version:set 0.2.0   # root, lib, every extension, and every internal pin
```

Commit, tag `v0.2.0`, publish a GitHub release for that tag.
`.github/workflows/publish.yml` checks the tag against the version, runs check + test,
then publishes the lib, each extension, and the umbrella via npm trusted publishing,
skipping any package whose version is already on the registry.

The first publish of every package is manual (`npm publish -w lib`,
`npm publish -w extensions/<tool>`, then `npm publish` for the root), because each
package's trusted publisher is configured in its own npmjs.com settings, which exist
only once the package does.

## License

Apache 2.0


