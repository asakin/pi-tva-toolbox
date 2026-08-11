# pi-pluck

Create a **labeled forgetful side-branch** in a [pi](https://pi.dev) session: omit
turns that match a regex, keep everything else on a parallel chain, stay on your
current trunk, and jump to the forgetful tip later via `/tree`.

## Usage

```
/pluck commit
/pluck banana
```

Confirm the plan, then open `/tree` and find `[plucked N/M /pattern/i HH:MM]` on
the first user message of the new branch. Continue from the tip under that label.

- Match text: user text, assistant text, toolCall name/args — never tool results.
- Matching is **turn-granular**: if any searchable entry in a turn matches, the
  whole turn is omitted (including a user prompt that did not match).
- The session head (first user prompt) is never dropped.
- Catch-all patterns are rejected when every **user-led** turn matches (preamble
  alone does not save a wipe).
- Resume stays on the trunk (a plain `custom` bookkeeping entry anchors the leaf).

## Mental model

`/pluck` does not rewrite your current path. It grows a **sibling** conversation
that looks like yours with matching turns removed, labels the first user message
on that chain, and leaves you on the trunk.

```
End state: /pluck banana

+------------------------------+       +------------------------------------+
| Trunk (you stay here)        |       | Forgetful side-branch              |
+------------------------------+       +------------------------------------+
| u1 hello                     |       | [plucked 1/3 /banana/i 12:00]      |
| a1 hi                        |       | u1' hello                          |
| u2 talk about banana         |  -->  | a1' hi                             |
| a2 about banana              |       | u3' continue                       |
| u3 continue                  |       | a3' continuing  <-- tip            |
| a3 continuing                |       +------------------------------------+
| custom pi-pluck  <-- leaf    |
+------------------------------+       u2/a2 gone; no hole in chain
```

- **Trunk** — unchanged history; a `custom` `pi-pluck` entry anchors the leaf so
  resume does not rebuild onto the forgetful tip.
- **Forgetful branch** — full kept chain cloned in parallel (no holes where turns
  were omitted); label on the first user message; continue from the tip under it.
- **Jump** — `/tree` → select the `[plucked …]` label → continue from the tip.

## Install

`/pluck` ships as part of the toolbox:

```bash
pi install git:github.com/asakin/pi-tva-toolbox
```

To load only this extension, use the object form in your settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/asakin/pi-tva-toolbox",
      "extensions": ["extensions/pi-pluck/src/index.ts"]
    }
  ]
}
```

Do **not** symlink into `~/.pi/agent/extensions/`. `/reload` after install. See the
[root README](../..) for path-installing a local checkout.

## Development

```bash
npm test        # node --test, from this workspace or the repo root
npm run check   # tsc --noEmit
```

Integration tests import `SessionManager.inMemory` from the
`@earendil-works/pi-coding-agent` peer dependency (resolved via your `pi`
install).

Session writes from a command context need a deliberate widen of
`ReadonlySessionManager` to the live `SessionManager` — see
`src/grow-forgetful-branch.ts`. Read Pi's session-format / tree docs, and
`pi-fork-off` next door, before changing grow/label/leaf behavior.

## Sharp edges

- **Session growth.** Grow clones the full kept chain onto a parallel branch, so
  forgetting 1 of 100 turns still duplicates ~99 turns of entries (including tool
  results) into the session file. That is intentional for `/tree` UX.
- **Private SessionManager API.** Cloning with remapped ids uses `_appendEntry`
  (not part of the public extension surface). Upstream renames will break grow
  until this extension is updated.
- **Not in scope (yet).** Regex ReDoS timeouts, auto-jump to the forgetful tip,
  and rewriting grow to use only public `append*` helpers.

Part of the [pi-tva-toolbox](../..) — timeline tools for Pi.

## License

Apache 2.0
