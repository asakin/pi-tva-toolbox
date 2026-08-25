# pi-pluck

Forget turns in a [pi](https://pi.dev) session without rewriting it: `/pluck regex`
appends **one note** to the active branch, and from then on the turns that matched
leave the model's window. They stay in the session file; `/unpluck` brings them back.

## Usage

```
/pluck commit
/pluck banana
/unpluck
```

Confirm the plan and you are done. Nothing moves: you stay on the same leaf, and the
next request the model sees is the same conversation minus the forgotten turns. The
note carries a label — `[plucked N/M /pattern/i HH:MM]` — that `/tree` shows as the
signpost for where the pluck happened.

- Match text: user text, assistant text, toolCall name/args — never tool results.
- Matching is **turn-granular**: if any searchable entry in a turn matches, the
  whole turn is forgotten (including a user prompt that did not match).
- The session head (first user prompt) is never dropped. If it matches, it is kept
  and only later matching turns are forgotten.
- Catch-all patterns are rejected when every **user-led** turn matches (preamble
  alone does not save a wipe).
- `/unpluck` lists the plucks still in effect on the active branch, lets you pick
  one, and appends a cancel note. The forgotten turns come straight back.

## Mental model

A pi session is an append-only tree; entries cannot be edited or re-parented.
`/pluck` therefore does not change history. It records a decision on the tree:

> From this point, the turns listed here do not belong in context.

The extension reads every such note on the active branch and, right before each
provider call, hands pi the message list without those turns. Compaction is shaped
the same way (`session_before_compact`), so a summary never re-describes a
forgotten turn, and plucks written before a compaction still apply after it.

What follows from that:

- **One entry per pluck.** Forgetting 7 turns out of 2,000 costs one line in the
  session file, not a copy of the other 1,993.
- **The file stays complete.** A pi session without the extension loaded shows the
  whole conversation. Plain `custom` entries never reach the model by contract, so
  nothing is missing and nothing breaks.
- **Recoverable by construction.** Nothing is deleted. `/unpluck` appends a note
  that cancels an earlier one; several plucks on one branch are a union, and later
  notes take precedence over earlier ones in branch order.
- **Whole turns only.** A turn is one user message plus everything until the next
  user message. The shaper never edits a message or drops half a turn.

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
      "extensions": ["node_modules/@arielsakin/pi-pluck/src/index.ts"]
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

Tests use plain entry fixtures and the `@earendil-works/pi-coding-agent` types
(resolved via your `pi` install). Only public extension APIs are used:
`pi.appendEntry` to write notes, `pi.setLabel` for the `/tree` label, and the
`context` / `session_before_compact` events to shape what the model reads.

## Sharp edges

- **Compaction footer.** pi computes the compaction summary's file list before
  extensions shape the input, so that footer may still mention files touched in
  forgotten turns. The summary text itself is generated from the shaped input.
- **Branch summaries are not shaped.** The summary pi writes when you jump between
  branches in `/tree` is built from the raw branch and can mention forgotten turns.
- **Whole turns only.** There is no way to forget a single assistant reply or tool
  result while keeping the user prompt that led to it.
- **Sessions plucked with an older version.** The retired clone-based `/pluck` left
  `trunk-anchor` notes and duplicated branches behind. Those sessions still load;
  the old notes are ignored and nothing is shaped by them.
- **Not in scope (yet).** Regex ReDoS timeouts, plucks that re-evaluate against
  future turns, session-only (unsaved) plucks, and toggling a pluck off without
  cancelling it.

Part of the [pi-tva-toolbox](../..) — timeline tools for Pi.

## License

Apache 2.0
