# pi-fork-off

`/fork-off` forks the current point of a [pi](https://pi.dev) session into several
labeled branches at once and leaves you where you were. Walk into any of them from
`/tree`.

Pi's `/fork` makes one branch and moves you into it. `/fork-off` prepares many from
the current leaf, one per approach, model, or hypothesis, so you can explore them in
any order.

## Install

```bash
pi install npm:@arielsakin/pi-fork-off
```

Try it without installing:

```bash
pi -e npm:@arielsakin/pi-fork-off
```

Or the whole set: `pi install npm:pi-tva-toolbox`. For a local checkout, see the
[root README](https://github.com/asakin/pi-tva-toolbox#readme).

## Usage

Numbered branches:

```
/fork-off 3
```

Named branches:

```
/fork-off redis-cache in-memory no-cache
```

Each branch is labeled with the time it was made, so a set is easy to spot in `/tree`:

```
🔀 14:22:07 redis-cache
🔀 14:22:07 in-memory
🔀 14:22:07 no-cache
```

Open `/tree`, select a label, and you land inside that branch with the conversation up
to the fork point intact. Type, and the work stays on that branch.

Two things to know in `/tree`:

- Each label has a `[fork-off]` line directly above it (the branch's head entry). Select
  the label, not that line; selecting the head line puts you back at the fork point,
  outside the branch.
- On first entry, pi asks whether to summarize the branch you are leaving, as it does
  for any `/tree` jump. Either answer is fine; the new branches are not affected.

## Behavior

- **Branches fan out from the current leaf.** Each carries the whole conversation up to
  that point.
- **You stay where you are.** The leaf returns to the fork point, and the session's
  persisted position stays on the branch you forked from, so resuming later does not
  drop you inside the last branch made.
- **Each branch knows what it is.** A hidden entry tells the agent which branch it is on
  and to wait for you. It is in the agent's context, not in the visible transcript.
- **The label marks where a branch starts.** Selecting it always returns to that starting
  point. Once you have worked in a branch, continue it the normal way: navigate to your
  latest message there.
- **Names are whitespace-separated**, so a branch name cannot contain a space. `/fork-off 3`
  (a bare number) always means "three numbered branches", never a branch named `3`.
- **Maximum 20 branches** per invocation.
- Requires a non-empty session.

## Implementation note

Each branch is two entries: a head that carries the brief, and the labeled marker below
it that you select. Pi treats selecting a `custom_message` as "rewind and let me retype
this", so it moves the leaf to the selected entry's *parent*. One labeled node per
branch would therefore send you back to the shared fork point instead of into the
branch.

The extension writes through four `SessionManager` methods on `ctx.sessionManager`:
`branch`, `appendCustomMessageEntry`, `appendLabelChange`, and `appendCustomEntry`.
See the comments in `src/index.ts`.

Part of [pi-tva-toolbox](https://github.com/asakin/pi-tva-toolbox): session-tree tools for pi.

## License

Apache 2.0
