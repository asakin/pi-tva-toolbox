# pi-clear

`/clear` rewinds the current branch of a [pi](https://pi.dev) session to before its
first user message and starts a new branch there. The context is cleared; the old
branch stays in `/tree`.

## Install

```bash
pi install npm:@arielsakin/pi-clear
```

Try it without installing:

```bash
pi -e npm:@arielsakin/pi-clear
```

Or the whole set: `pi install npm:pi-tva-toolbox`. For a local checkout, see the
[root README](https://github.com/asakin/pi-tva-toolbox#readme).

## Usage

```
/clear
```

From any point in a session. Works on any branch of the tree; the rewind targets the
first user message of the branch you are on.

- The context is cleared: the next message starts a fresh conversation.
- The old branch stays in the tree, one `/tree` jump away.
- The first user message of the branch is labeled `⌛ clear HH:MM`, marking when the
  clear happened. Repeated clears update the same label.
- The editor is left empty; the seed prompt stays labeled in `/tree`.
- No summary is written. For a summary checkpoint, use `/tree` navigation with
  summarize instead.

Pi's `/new` starts a separate session file; `/clear` stays in the current one. If a
future pi ships a built-in `/clear`, this command is reachable as `/clear:1` and pi
reports the collision at startup.

Part of [pi-tva-toolbox](https://github.com/asakin/pi-tva-toolbox): session-tree tools for pi.

## License

Apache 2.0
