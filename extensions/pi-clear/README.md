# pi-clear

`/clear` as the counter to `/new`, the way `/tree` is the counter to `/fork`.

Claude's `/clear` wipes your context and strands the old conversation in a
saved file. Pi already has `/new` for that. This `/clear` rewinds the
**current** session tree to before its first user message and grows a new
branch from there:

- The context is genuinely cleared — the agent wakes up at the beginning.
- The old timeline stays in the tree, one `/tree` jump away.
- The first user message — the session's seed prompt — is always labeled
  `⌛ clear HH:MM`, marking when the jump happened. The new branch re-sends
  the same prompt, so the marker belongs to the event more than to either
  side.
- The first message's text is handed back in the editor, because a session's
  first prompt is usually its intent. Re-send it as-is, edit it into the new
  branch's seed, or clear it and type something else.

No summarization, no residue — a clear clear. (If you want a summary
checkpoint before jumping, that's what `/tree` navigation with summarize is
for; this command deliberately stays the fast path.)

## Install

```bash
pi install git:github.com/asakin/pi-tva-toolbox@main --extension @arielsakin/pi-clear
```

Or from the monorepo checkout, symlink `src/index.ts` into
`~/.pi/agent/extensions/`.

## Usage

```
/clear
```

From any point in a session. Works on any branch of the tree; the rewind
targets the first user message of the branch you're on.

Part of the [pi-tva-toolbox](../..) — timeline tools for Pi.
