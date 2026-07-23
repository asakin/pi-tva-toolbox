import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Helper for debugging.
const LOG_FILE = path.join(getAgentDir(), "tva.log");

function logDebug(message: string) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PRUNER] ${message}\n`);
  } catch (error) {
    process.stderr.write(`tva: cannot write ${LOG_FILE}: ${error}\n`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prune", {
    description: "Deploy Reset Charges: Prune all branches labeled 'TVA-PRUNE'",
    handler: async (args, ctx) => {
      logDebug("\n=== T.V.A. Reset Charge Deployed ===");
      
      const entries = ctx.sessionManager.getEntries() as SessionEntry[];
      const pruneTargets: SessionEntry[] = [];

      logDebug(`Scanning ${entries.length} timeline entries for TVA-PRUNE variants...`);

      // 1. Label Scanner: Find all nodes labeled "TVA-PRUNE"
      for (const entry of entries) {
        const label = ctx.sessionManager.getLabel(entry.id);
        if (label === "TVA-PRUNE") {
          pruneTargets.push(entry);
        }
      }

      if (pruneTargets.length === 0) {
        logDebug("No TVA-PRUNE labels found. Sacred Timeline is secure.");
        ctx.ui.notify("No branches labeled 'TVA-PRUNE' found.", "info");
        return;
      }

      logDebug(`Found ${pruneTargets.length} root nodes designated for pruning.`);
      for (const target of pruneTargets) {
        logDebug(`  - Variant located at entryId: ${target.id}`);
      }

      // 2. Descendant Mapper: Find all children of the condemned nodes
      const parentMap = new Map<string, string | null>();
      for (const e of entries) {
        parentMap.set(e.id, e.parentId ?? null);
      }

      // We need a fast way to get children.
      const childrenMap = new Map<string, string[]>();
      for (const e of entries) {
        if (e.parentId) {
          const siblings = childrenMap.get(e.parentId) || [];
          siblings.push(e.id);
          childrenMap.set(e.parentId, siblings);
        }
      }

      const condemnedIds = new Set<string>();

      // Recursive function to mark a node and all its children for deletion
      const condemnBranch = (nodeId: string) => {
        if (condemnedIds.has(nodeId)) return; // Already condemned
        condemnedIds.add(nodeId);
        
        const children = childrenMap.get(nodeId) || [];
        for (const childId of children) {
          condemnBranch(childId);
        }
      };

      for (const target of pruneTargets) {
        condemnBranch(target.id);
      }

      logDebug(`Descendant Mapper identified ${condemnedIds.size} total entries to be pruned.`);

      // Protect the Sacred Timeline (The active branch cannot be pruned)
      // If any of the condemned nodes are in the active branch, we must abort, 
      // otherwise Pi's active context will crash.
      const activeBranch = ctx.sessionManager.getBranch() as SessionEntry[];
      for (const activeNode of activeBranch) {
        if (condemnedIds.has(activeNode.id)) {
          logDebug(`[ERROR] Attempted to prune a node (${activeNode.id}) on the active Sacred Timeline. Aborting.`);
          ctx.ui.notify("Cannot prune: One or more targets are on the active timeline.", "error");
          return;
        }
      }

      // 3. The Reset Charge: Filter the entries array and rewrite the file
      const survivingEntries = entries.filter((e) => !condemnedIds.has(e.id));
      
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot prune: No active session file.", "error");
        return;
      }

      try {
        logDebug(`Applying Reset Charge to ${sessionFile}...`);
        
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
        // session, so the manager would keep the condemned entries in memory and
        // write them back on its next rewrite. switchSession to the same file is
        // the resume path -- it reopens the file and rebuilds the runtime.
        ctx.ui.notify(`Pruned ${condemnedIds.size} variants. Reloading timeline...`, "info");
        await ctx.switchSession(sessionFile);

      } catch (error: any) {
        logDebug(`[ERROR] Pruning failed: ${error.message}\n${error.stack}`);
        ctx.ui.notify(`Pruning failed: ${error.message}`, "error");
      }
    }
  });
}
