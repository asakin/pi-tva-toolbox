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

```bash
pi install git:github.com/asakin/pi-pluck
pi list
```

Dev install from a local checkout:

```bash
pi install /path/to/pi-pluck
pi list
```

Do **not** symlink into `~/.pi/agent/extensions/`. `/reload` after install.

To refresh a local install after edits:

```bash
pi remove /path/to/pi-pluck
pi install /path/to/pi-pluck
```

## Development

```bash
bun test
```

Integration tests import `SessionManager.inMemory` from the
`@earendil-works/pi-coding-agent` peer dependency (resolved via your `pi`
install).

## Sharp edges

- **Session growth.** Grow clones the full kept chain onto a parallel branch, so
  forgetting 1 of 100 turns still duplicates ~99 turns of entries (including tool
  results) into the session file. That is intentional for `/tree` UX.
- **Private SessionManager API.** Cloning with remapped ids uses `_appendEntry`
  (not part of the public extension surface). Upstream renames will break grow
  until this extension is updated.
- **Not in scope (yet).** Regex ReDoS timeouts, auto-jump to the forgetful tip,
  and rewriting grow to use only public `append*` helpers.

## License

MIT
