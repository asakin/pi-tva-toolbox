# pi-fork-off

Fork one point in a session into several labeled branches at once, then walk into them from
`/tree`.

Pi's native fork makes one branch and moves you into it. `/fork-off` prepares *many* from the
current leaf and leaves you where you were, so you can set up a fan of parallel attempts — one
per approach, one per model, one per hypothesis — and explore them in any order.

## Usage

Numbered branches:

```
/fork-off 3
```

Named branches:

```
/fork-off redis-cache in-memory no-cache
```

Each branch is labeled with the time it was made, so a fan is easy to spot in `/tree`:

```
🔀 14:22:07 redis-cache
🔀 14:22:07 in-memory
🔀 14:22:07 no-cache
```

Open `/tree`, select a branch, and you land inside it with the conversation up to that point
intact. Type, and the work stays on that branch.

## Behavior

- **Branches fan out from the current leaf.** Each carries the whole conversation up to that
  point.
- **You stay where you are.** The leaf is restored to the base, and the session's persisted
  position stays on the trunk — resuming later does not drop you inside the last branch made.
- **Each branch knows what it is.** A hidden entry tells the agent which branch it is on and to
  wait for you, so arriving via `/tree` doesn't trigger an unprompted reply. It is in the agent's
  context, not in the visible transcript.
- **The label marks where a branch starts.** Selecting it always returns to that starting point.
  Once you have worked in a branch, continue it the normal way — navigate to your latest message
  there.
- **Names are whitespace-separated**, so a branch name cannot contain a space. `/fork-off 3` (a
  bare number) always means "three numbered branches", never a branch named `3`.
- **Maximum 20 branches** per invocation.
- Requires a non-empty session.

## Implementation note

Each branch is two entries: a head that carries the brief, and the labeled marker below it that
you select. That shape is deliberate — Pi treats selecting a `custom_message` as "rewind and let
me retype this", so it moves the leaf to the selected entry's *parent*. One labeled node per
branch would therefore send you back to the shared base instead of into the branch. See the
comments in `src/fork-off.ts`.

Part of the [pi-tva-toolbox](../..) — timeline tools for Pi.

## License

Apache 2.0
