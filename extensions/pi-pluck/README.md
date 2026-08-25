# pi-pluck

`/pluck regex` forgets the turns of a [pi](https://pi.dev) session that match a regex,
without rewriting the session: one note is appended to the active branch, and from
then on the matching turns leave the model's window. They stay in the session file;
`/unpluck` brings them back.

## Install

```bash
pi install npm:@arielsakin/pi-pluck
```

Try it without installing:

```bash
pi -e npm:@arielsakin/pi-pluck
```

Or the whole set: `pi install npm:pi-tva-toolbox`. For a local checkout, see the
[root README](https://github.com/asakin/pi-tva-toolbox#readme).

## Usage

```
/pluck commit
/pluck banana
/unpluck
```

Confirm the plan and you are done. Nothing moves: you stay on the same leaf, and the
next request the model sees is the same conversation minus the forgotten turns. The
note carries a label, `plucked N/M /pattern/i HH:MM`, that marks where the pluck
happened. `/tree` hides plain notes by default; press Ctrl+O to switch the filter to
labeled-only (or all) and the label shows.

How it works: `/pluck` appends one custom entry; the context hook drops the listed
turns before each model call and before compaction; `/unpluck` appends a cancel entry.
Nothing in the file changes, and a pi without the extension loaded shows the whole
conversation.

- Match text: user text, assistant text, tool call name and arguments. Tool results
  are never searched.
- Matching is **turn-granular**: if any searchable entry in a turn matches, the whole
  turn is forgotten (including a user prompt that did not match). A turn is one user
  message plus everything until the next user message.
- The first user prompt of the session is never dropped. If it matches, it is kept and
  only later matching turns are forgotten.
- Catch-all patterns are rejected when every **user-led** turn matches (preamble alone
  does not save a wipe).
- Several plucks on one branch are a union; later notes take precedence over earlier
  ones in branch order. Forgetting 7 turns out of 2,000 costs one line in the session
  file.
- `/unpluck` lists the plucks still in effect on the active branch, lets you pick one,
  and appends a cancel note. The forgotten turns come straight back.

## Limitations

- **Compaction footer.** pi computes the compaction summary's file list before
  extensions shape the input, so that footer may still mention files touched in
  forgotten turns. The summary text itself is generated from the shaped input.
- **Branch summaries are not shaped.** The summary pi writes when you jump between
  branches in `/tree` is built from the raw branch and can mention forgotten turns.
- **Whole turns only.** There is no way to forget a single assistant reply or tool
  result while keeping the user prompt that led to it.
- **Not in scope.** Regex timeouts (a pathological pattern can hang the match), plucks
  that re-evaluate against future turns, session-only (unsaved) plucks, and toggling a
  pluck off without cancelling it.

## Development

```bash
npm test        # node --test, from this workspace or the repo root
npm run check   # tsc --noEmit
```

Tests use plain entry fixtures and the `@earendil-works/pi-coding-agent` types
(resolved via your `pi` install). Only public extension APIs are used:
`pi.appendEntry` to write notes, `pi.setLabel` for the `/tree` label, and the
`context` / `session_before_compact` events to shape what the model reads.

Part of [pi-tva-toolbox](https://github.com/asakin/pi-tva-toolbox): session-tree tools for pi.

## License

Apache 2.0
