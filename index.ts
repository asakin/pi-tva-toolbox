import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

async function getSubdirectories(currentPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    // Filter to directories that don't start with a dot
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name + "/");
    return dirs.sort();
  } catch (error) {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  // Hook into the native fork process BEFORE it executes
  pi.on("session_before_fork", async (event, ctx) => {
    let currentDir = ctx.cwd;
    let absoluteTargetDir: string | undefined;

    // 1. Interactive Directory Browser
    while (true) {
      const dirs = await getSubdirectories(currentDir);
      const displayPath = currentDir.replace(os.homedir(), "~");
      
      const choices = [
        `[ Graft Here: ${displayPath} ]`,
        "~/ (Go to home)",
        "../ (Go up)",
        ...dirs
      ];

      const selection = await ctx.ui.select(`Time Heist - Navigate to target:`, choices);

      // User hit escape or cancelled
      if (!selection) {
        ctx.ui.notify("Heist aborted.", "warning");
        return { cancel: true };
      }

      if (selection.startsWith("[ Graft Here")) {
        absoluteTargetDir = currentDir;
        break;
      } else if (selection === "../ (Go up)") {
        currentDir = path.dirname(currentDir);
      } else if (selection === "~/ (Go to home)") {
        currentDir = os.homedir();
      } else {
        // Navigating into a subdirectory
        currentDir = path.join(currentDir, selection.replace("/", ""));
      }
    }

    // 2. Delegate to Native Fork
    // If the user navigated to the exact same path they are currently in,
    // we return undefined/void, which tells Pi to proceed with its native in-place fork.
    if (absoluteTargetDir === ctx.cwd) {
      return; 
    }

    // 3. The Heist (Cross-Directory Fork via native switchSession API)
    // We are changing directories, so we must CANCEL the native fork and execute our own.
    try {
      // Ensure the target directory exists so Pi doesn't throw when trying to bind the workspace
      await fs.mkdir(absoluteTargetDir, { recursive: true });

      // Grab the exact Sacred Timeline (the straight-line branch up to the specific node selected)
      // `event.entryId` is the specific node the user chose to fork from in the Tree UI.
      const entries = ctx.sessionManager?.getEntries?.() || [];
      const branchEntries = [];
      const parentMap = new Map();
      
      for (const e of entries) {
        parentMap.set(e.id, e);
      }

      // Walk backward from the target entryId to the root
      let currentId = event.entryId;
      while (currentId && parentMap.has(currentId)) {
        const e = parentMap.get(currentId);
        branchEntries.unshift(e); // Add to front for chronological order
        currentId = e.parentId;
      }

      const parentSession = ctx.sessionManager?.getSessionFile?.();

      ctx.ui.notify(`Grafting timeline to ${absoluteTargetDir}...`, "info");

      // Delegate completely to Pi's native session creation API.
      // We use `switchSession` + `newSession` logic: 
      // First we must generate the new session using `newSession` so the file actually exists,
      // and we can populate its history. BUT newSession automatically switches you into it.
      
      const result = await ctx.newSession({
        cwd: absoluteTargetDir,
        parentSession,
        setup: async (newSessionManager) => {
          // Replay the exact history up to the fork point into the new session
          for (const entry of branchEntries) {
            if (entry.type === "message") {
              newSessionManager.appendMessage(entry.message);
            } else if (entry.type === "custom") {
              newSessionManager.appendEntry(entry);
            }
          }
        },
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Sacred Timeline successfully grafted into ${absoluteTargetDir}`, "success");
        }
      });

      if (result.cancelled) {
        ctx.ui.notify("Cross-directory heist was cancelled.", "warning");
      }

    } catch (error: any) {
      ctx.ui.notify(`Heist failed: ${error.message}`, "error");
    }

    // Crucial: Cancel the native fork, because we just executed the cross-directory Heist manually!
    return { cancel: true };
  });

  pi.registerCommand("tva-status", {
    description: "Check the status of the Sacred Timeline",
    handler: async (args, ctx) => {
      ctx.ui.notify("The Sacred Timeline is secure.", "info");
    },
  });
}
