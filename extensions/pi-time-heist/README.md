# pi-time-heist

Fork a [pi](https://pi.dev) session from any point in its tree into a **different
working directory**, without leaving pi.

`cd other && pi --fork <id>` already does something close: it copies the whole session
tree into the new directory and starts fresh. pi-time-heist stays inside the running
session, lets you pick the fork point in pi's own `/fork` UI, and copies only the
branch up to that point into a new session whose working directory is the one you
chose.

## Install

```bash
pi install npm:@arielsakin/pi-time-heist
```

Try it without installing:

```bash
pi -e npm:@arielsakin/pi-time-heist
```

Or the whole set: `pi install npm:pi-tva-toolbox`. For a local checkout, see the
[root README](https://github.com/asakin/pi-tva-toolbox#readme).

## Usage

Fork as you normally would (`/fork` or `/clone`, or your bound key) and pick the
message to fork from. Instead of forking immediately, a directory picker appears:

```
Time Heist - target: ~/projects
  [ graft here ]
  ~/
  ../
  my-service/
  my-website/
```

Navigate and choose `[ graft here ]`. Picking the directory you are already in hands
the fork back to pi, which forks natively. Picking another directory records it:

```
Heist trajectory locked → ~/projects/other-repo
Type /heist to initiate the jump.
```

Run `/heist` and you land in a new session in that directory, carrying the branch up
to the message you forked from:

```
Branch history grafted into ~/projects/other-repo
```

Two steps because the fork hook can only cancel the native fork and remember the
target; switching sessions is available to commands, so `/heist` finishes the move.

## Behavior

- Respects the fork position: forking *before* a message excludes it, matching pi, and
  its text is handed back in the editor.
- The new session's header records the target directory, which is how the working
  directory moves: `switchSession` rebuilds the runtime at the header's cwd.
- The source session is untouched. No intermediate fork is created.
- The copied history still refers to the source directory: file paths in tool calls
  and results, and anything the model concluded about that tree. Read the first reply
  in the new session with that in mind.
- A recorded target is dropped if the session changes underneath it, on `/reload`, and
  on any failure. There is no retry; fork again.
- Escaping the picker cancels the fork (`Heist aborted.`).
- Requires a persisted session and an interactive UI.

## What it writes

- The target directory, created if missing.
- One new session file under pi's session directory for that target, next to the ones
  pi itself would create there (`~/.pi/agent/sessions/--<target-path>--/`).
- A step log at `~/.pi/agent/tva.log` (tag `HEIST`), written through `@arielsakin/pi-tva-lib`.

Nothing leaves your machine.

Part of [pi-tva-toolbox](https://github.com/asakin/pi-tva-toolbox): session-tree tools for pi.

## License

Apache 2.0
