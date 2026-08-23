import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "@arielsakin/pi-tva-lib";

const logDebug = createLogger("PRUNER");

// Every root id plus every descendant of one. Entries may arrive in any order.
export function collectDoomed(entries: SessionEntry[], rootIds: Iterable<string>): Set<string> {
  // We need a fast way to get children.
  const childrenMap = new Map<string, string[]>();
  for (const e of entries) {
    if (e.parentId) {
      const siblings = childrenMap.get(e.parentId) || [];
      siblings.push(e.id);
      childrenMap.set(e.parentId, siblings);
    }
  }

  const doomedIds = new Set<string>();

  // Recursive function to mark a node and all its children for deletion
  const markBranch = (nodeId: string) => {
    if (doomedIds.has(nodeId)) return; // Already marked
    doomedIds.add(nodeId);

    const children = childrenMap.get(nodeId) || [];
    for (const childId of children) {
      markBranch(childId);
    }
  };

  for (const id of rootIds) {
    markBranch(id);
  }
  return doomedIds;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prune", {
    description: "Prune all branches labeled 'TVA-PRUNE' and their descendants",
    handler: async (args, ctx) => {
      logDebug("\n=== prune ===");
      
      const entries = ctx.sessionManager.getEntries() as SessionEntry[];
      const pruneTargets: SessionEntry[] = [];

      logDebug(`Scanning ${entries.length} entries for TVA-PRUNE labels...`);

      // 1. Label Scanner: Find all nodes labeled "TVA-PRUNE"
      for (const entry of entries) {
        const label = ctx.sessionManager.getLabel(entry.id);
        if (label === "TVA-PRUNE") {
          pruneTargets.push(entry);
        }
      }

      if (pruneTargets.length === 0) {
        logDebug("No TVA-PRUNE labels found. Nothing to prune.");
        ctx.ui.notify("No branches labeled 'TVA-PRUNE' found.", "info");
        return;
      }

      logDebug(`Found ${pruneTargets.length} root nodes designated for pruning.`);
      for (const target of pruneTargets) {
        logDebug(`  - Marked branch root at entryId: ${target.id}`);
      }

      // 2. Descendant Mapper: Find all children of the marked nodes
      const doomedIds = collectDoomed(entries, pruneTargets.map((t) => t.id));

      logDebug(`Descendant Mapper identified ${doomedIds.size} total entries to be pruned.`);

      // Protect the active branch (it cannot be pruned).
      // If any of the marked nodes are in the active branch, we must abort, 
      // otherwise Pi's active context will crash.
      const activeBranch = ctx.sessionManager.getBranch() as SessionEntry[];
      for (const activeNode of activeBranch) {
        if (doomedIds.has(activeNode.id)) {
          logDebug(`[ERROR] Attempted to prune a node (${activeNode.id}) on the active branch. Aborting.`);
          ctx.ui.notify("Cannot prune: One or more targets are on the active timeline.", "error");
          return;
        }
      }

      // 3. Filter the entries array and rewrite the file
      const survivingEntries = entries.filter((e) => !doomedIds.has(e.id));
      
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot prune: No active session file.", "error");
        return;
      }

      try {
        logDebug(`Rewriting ${sessionFile}...`);
        
        // We must preserve the exact header row.
        const fileContent = await readFile(sessionFile, "utf-8");
        const lines = fileContent.split("\n").filter(Boolean);
        const header = lines[0];

        // Stringify surviving entries
        const stringifiedEntries = survivingEntries.map((e) => JSON.stringify(e));
        const splicedLines = [header, ...stringifiedEntries];

        await writeFile(sessionFile, splicedLines.join("\n") + "\n", "utf-8");

        logDebug(`Pruning complete. Surviving entries: ${survivingEntries.length}`);

        // 4. Re-read the session from disk so the live manager drops the pruned
        // entries. reload() only reloads extensions/skills/themes, not the
        // session, so the manager would keep the deleted entries in memory and
        // write them back on its next rewrite. switchSession to the same file is
        // the resume path -- it reopens the file and rebuilds the runtime.
        ctx.ui.notify(`Pruned ${doomedIds.size} entries. Reloading session...`, "info");
        await ctx.switchSession(sessionFile);

      } catch (error: any) {
        logDebug(`[ERROR] Pruning failed: ${error.message}\n${error.stack}`);
        ctx.ui.notify(`Pruning failed: ${error.message}`, "error");
      }
    }
  });
}
