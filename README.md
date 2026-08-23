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

From npm:

```bash
pi install npm:pi-tva-toolbox
```

Or straight from git:

```bash
pi install git:github.com/asakin/pi-tva-toolbox
```

To load only some of the listed extensions, use the object form in your settings:

```json
{
  "packages": [
    {
      "source": "npm:pi-tva-toolbox",
      "extensions": ["extensions/pi-time-heist/src/index.ts"]
    }
  ]
}
```

The toolbox is the unit: individual extensions are not published separately.
Filter as above to load a subset.

## Development

This repo is the **multi-extension package** pattern (contrast with a single-folder
extension like `pi-ambient`): one installable root, explicit opt-in list in
`package.json` → `pi.extensions`. Mid-development tools live under `extensions/`
but stay unloaded until you append their entry path to that array.

Each tool under `extensions/` is also its own npm workspace (own `package.json`,
version, and per-package `pi` manifest) so it typechecks and tests in isolation.
Code shared across tools lives in `lib/` (the `tva.log` writer), which is why the
root, not a workspace, is the publishable unit.

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

To ship a new tool: add the workspace under `extensions/`, then append its entry
path to the root `pi.extensions` array when it is ready to load.

### Release

Bump `version` in the root `package.json`, tag it `vX.Y.Z`, and publish a GitHub
release for that tag. `.github/workflows/publish.yml` checks the tag against the
version, runs check + test, and publishes the root package to npm via trusted
publishing. The first publish is manual (`npm publish` from a clean checkout), since
the trusted publisher is configured in the package's npmjs.com settings, which exist
only once the package does.

## License

Apache 2.0
