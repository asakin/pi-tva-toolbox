# pi-pruner

Permanently delete dead branches from a Pi session's `.jsonl` file, keeping the session
DAG small and fast to load.

Pi's session file is append-only: abandoned forks stay in it forever, and every one of them
is re-read on load. `/prune` removes a branch you have marked as dead, along with all of
its descendants.

## Usage

1. Open the `/tree` UI in Pi.
2. Select the node where the dead branch starts.
3. Press `Shift + L` and label it `TVA-PRUNE`.
4. Run `/prune` in the chat.

That node and every entry beneath it are deleted from the file, and the session is
reloaded from disk.

## Behavior

- **Deletion is permanent.** The entries are removed from the `.jsonl`; there is no undo.
- **The active branch is protected.** If any marked node sits on the branch you are
  currently on, the whole prune aborts rather than cutting the ground out from under the
  live session.
- **The session header is preserved** byte-for-byte, so the working directory and session
  metadata survive the rewrite.
- Progress is traced to `<agentDir>/tva.log`, usually `~/.pi/agent/tva.log`.

Part of the [pi-tva-toolbox](../..) — timeline tools for Pi.

## License

Apache 2.0
