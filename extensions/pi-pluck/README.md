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
- The session head (first user prompt) is never dropped.
- Catch-all patterns (every turn matches) are rejected.
- Resume stays on the trunk (a plain `custom` bookkeeping entry anchors the leaf).

## Install

```bash
pi install /Users/arielsakin/projects/OSS/pi-extensions/pi-pluck
pi list
```

When published:

```bash
pi install git:github.com/asakin/pi-pluck
```

Do **not** symlink into `~/.pi/agent/extensions/`. `/reload` after install.

```bash
pi remove /Users/arielsakin/projects/OSS/pi-extensions/pi-pluck
pi install /Users/arielsakin/projects/OSS/pi-extensions/pi-pluck
```

## Development

```bash
bun test
```

## License

MIT
