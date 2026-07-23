# pi-tva-toolbox

A Time Variance Authority (TVA) inspired collection of [Pi](https://pi.dev) extensions for
time travel, session trees, and forks.

Pi sessions are append-only DAGs of JSON entries. These tools manipulate that graph:
moving timelines between directories, pruning branches, and generally interfering with the
Sacred Timeline.

## Extensions

| Extension | Trigger | What it does |
| --- | --- | --- |
| [pi-time-heist](extensions/pi-time-heist) | fork, then `/heist` | Fork a session from any point in its tree into a *different* working directory |
| [pi-pruner](extensions/pi-pruner) | `/prune` | Prune branches labeled `TVA-PRUNE` (and their descendants) from the session tree |
| [pi-clear](extensions/pi-clear) | `/clear` | Rewind the session to its first user message as a new branch |
| [pi-version-sentinel](extensions/pi-version-sentinel) | automatic | Catch a stale dependency version before it's written — a memory-refresh for autonomous agents |

## Install

The whole toolbox, from git:

```bash
pi install git:github.com/asakin/pi-tva-toolbox
```

Every extension under `extensions/` is discovered automatically, so new tools arrive with
a `pi update`.

To load only some of them, use the object form in your settings instead:

```json
{
  "packages": [
    {
      "source": "git:github.com/asakin/pi-tva-toolbox",
      "extensions": ["extensions/pi-time-heist/src/heist.ts"]
    }
  ]
}
```

Individual packages are not on npm yet. When they are, the scope is `@arielsakin` — note
that it differs from the GitHub account:

```bash
pi install npm:@arielsakin/pi-time-heist      # not published yet
```

## Development

Each extension is an npm workspace under `extensions/`, with its own `package.json`, `pi`
manifest, and version. The root package is private and ships nothing.

```bash
npm install
npm run check      # typecheck every workspace
```

Extensions are plain TypeScript, loaded by Pi through jiti. There is no build step.

## License

Apache 2.0
