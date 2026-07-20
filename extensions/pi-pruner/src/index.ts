import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Helper for debugging.
function getAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

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

      // TODO: Slice 3 (Descendant Mapper) & Slice 4 (Reset Charge) will follow here.
      ctx.ui.notify(`Found ${pruneTargets.length} variants. Pruning logic pending implementation...`, "warning");
    }
  });
}
