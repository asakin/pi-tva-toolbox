# pi-pruner

A Time Variance Authority (TVA) extension for Pi coding agent. 

Deploys "Reset Charges" to prune abandoned timelines (dead branches) from your session `.jsonl` files, keeping your session DAG small and performant.

## Usage

1. Open the `/tree` UI in Pi.
2. Select a node where a dead timeline branches off.
3. Press `Shift + L` and label it `TVA-PRUNE`.
4. Run `/prune` in the chat.

The extension will permanently delete that node and all its descendants.
