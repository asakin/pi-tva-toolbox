# Time Heist

Fork a Pi session from any point in its tree into a **different working directory**.

Pi's native fork always lands in the current directory. Time Heist intercepts the fork,
lets you browse to a target directory, grafts the branch history into a new session there,
and switches you into it — moving the working directory in the process.

## Usage

Fork as you normally would (`/fork`, or your bound key), and pick the message to fork
from. Instead of forking immediately, a directory browser appears:

```
Time Heist - target: ~/projects
  [ graft here ]
  ../
  ~/
  companions/
  pi-tva-toolbox/
```

Navigate and choose `[ graft here ]`. If you pick the directory you are already in,
nothing special happens and Pi forks natively.

Pick a different directory and the trajectory is locked:

```
Heist trajectory locked → ~/projects/other-repo
Type /heist to initiate the jump.
```

Run `/heist` and you land in a new session in that directory, carrying the history up to
the message you forked from.

## Why two steps

Pi only exposes session switching (`ctx.switchSession`) to **command** contexts. Hooks get
a plain `ExtensionContext`, which has no such method — so the `session_before_fork` hook
cannot complete the jump itself.

But only the hook receives `event.entryId`: the tree node you selected in Pi's fork UI. A
command has no way to obtain it.

So the work is split. The hook captures what only it can see and cancels the native fork;
`/heist` spends that and performs the switch. The alternative would be replacing Pi's tree
UI with a homegrown message picker, which is worse.

## Behavior

- Respects `event.position` — forking *before* a message excludes it, matching Pi, and its
  text is handed back in the editor.
- The new session's header records the target directory, which is how the working
  directory actually moves: `switchSession` rebuilds the runtime at the header's cwd.
- The source session is untouched. No intermediate fork is created.
- A locked heist is discarded if the session changes underneath it, and any failure clears
  it. There is no retry — fork again.
- Requires a persisted session and an interactive UI.

## Debugging

Every step is traced to `<agentDir>/tva.log`, usually `~/.pi/agent/tva.log`:

```
[Step 0] Forking before entry 0d14fccb in /Users/…/source-repo
[Step 1] Locked target /Users/…/target-repo
[Step 2] Executing heist to /Users/…/target-repo
[Step 3] Reconstructed branch history: 758 entries
[Step 4] Created shell session 019f806e-… at …/2026-…-Z_019f806e-….jsonl
[Step 5] Wrote header + 758 entries
[Step 6] switchSession cancelled=false
```

If a heist stalls, the last step reached tells you which half failed.

## License

Apache 2.0
