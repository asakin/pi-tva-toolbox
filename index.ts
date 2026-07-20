import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Helper for debugging.
const LOG_FILE = path.join(getAgentDir(), "tva.log");

function logDebug(message: string) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch (error) {
    // Report rather than swallow, but never let a bad log path kill the fork.
    process.stderr.write(`tva: cannot write ${LOG_FILE}: ${error}\n`);
  }
}

// Browser menu entries.
const GRAFT_HERE = "[ graft here ]";
const GO_UP = "../";
const GO_HOME = "~/";

async function getSubdirectories(currentPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    
    // Filter to directories that don't start with a dot
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name + "/");
    return dirs.sort();
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  // Hook into the native fork process BEFORE it executes
  pi.on("session_before_fork", async (event, ctx) => {
    const home = os.homedir();
    let currentDir = ctx.cwd;
    let absoluteTargetDir: string | undefined;

    logDebug(`\n=== T.V.A. Time Heist Initiated ===`);
    logDebug(`[Step 0] Forking from entryId: ${event.entryId} in ${ctx.cwd}`);

    // 1. Interactive Directory Browser
    while (true) {
      const dirs = await getSubdirectories(currentDir);
      // Only collapse a leading home path, not one appearing mid-string.
      const inHome = currentDir === home || currentDir.startsWith(home + path.sep);
      const displayPath = inHome ? "~" + currentDir.slice(home.length) : currentDir;

      const choices = [
        GRAFT_HERE,
        GO_UP,
        GO_HOME,
        ...dirs
      ];

      const selection = await ctx.ui.select(`Time Heist - target: ${displayPath}`, choices);

      // User hit escape or cancelled
      if (!selection) {
        logDebug(`[Step 1] Aborted at ${currentDir}`);
        ctx.ui.notify("Heist aborted.", "warning");
        return { cancel: true };
      }

      if (selection === GRAFT_HERE) {
        absoluteTargetDir = currentDir;
        break;
      } else if (selection === GO_UP) {
        currentDir = path.dirname(currentDir);
      } else if (selection === GO_HOME) {
        currentDir = home;
      } else {
        // Navigating into a subdirectory
        currentDir = path.join(currentDir, selection.replace("/", ""));
      }
    }
    logDebug(`[Step 1] Target directory: ${absoluteTargetDir}`);

    // 2. Delegate to Native Fork
    // If the user navigated to the exact same path they are currently in,
    // we return undefined/void, which tells Pi to proceed with its native in-place fork.
    if (absoluteTargetDir === ctx.cwd) {
      logDebug(`[Step 2] Same directory, deferring to native fork.`);
      return;
    }

    // 3. The Heist (Cross-Directory Fork)
    // We are changing directories, so we must CANCEL the native fork and execute our own.
    try {
      // Ensure the target directory exists so Pi doesn't throw when trying to bind the workspace
      await fs.mkdir(absoluteTargetDir, { recursive: true });

      // Grab the exact Sacred Timeline (the straight-line branch up to the specific node selected)
      // `event.entryId` is the specific node the user chose to fork from in the Tree UI.
      const entries = ctx.sessionManager.getEntries();
      const branchEntries = [];
      const parentMap = new Map(entries.map((e) => [e.id, e]));

      // Walk backward from the target entryId to the root
      let currentId = event.entryId;
      while (currentId && parentMap.has(currentId)) {
        const e = parentMap.get(currentId)!;
        branchEntries.unshift(e); // Add to front for chronological order
        currentId = e.parentId!;
      }
      logDebug(`[Step 3] Reconstructed branch history: ${branchEntries.length} entries`);

      ctx.ui.notify(`Grafting timeline to ${absoluteTargetDir}...`, "info");

      // 4. Build the shell session for the target directory.
      // SessionManager.create takes the cwd as its first argument, so the header is
      // stamped with the target directory. It mints the UUID, the filename and the
      // parentSession link, which is why this no longer shells out to `pi --print`.
      // We pass sessionDir explicitly because the default resolves against the process
      // agent dir, which is wrong if pi was started with a relocated one.
      const targetSessionDir = path.join(
        path.dirname(ctx.sessionManager.getSessionDir()),
        `--${absoluteTargetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
      );
      const targetManager = SessionManager.create(absoluteTargetDir, targetSessionDir, {
        parentSession: ctx.sessionManager.getSessionFile(),
      });

      const targetSessionFilePath = targetManager.getSessionFile()!;
      const header = targetManager.getHeader()!;
      logDebug(`[Step 4] Created shell session ${header.id} at ${targetSessionFilePath}`);

      // 5. Rebuild the file: header row + the branch we just walked.
      // Written directly rather than through appendMessage, which would re-id every
      // entry and break the parent chain.
      const splicedLines = [header, ...branchEntries].map((e) => JSON.stringify(e));
      await fs.writeFile(targetSessionFilePath, splicedLines.join("\n") + "\n", "utf-8");
      logDebug(`[Step 5] Wrote header + ${branchEntries.length} entries`);

      // 6. Point the live session at the file we just wrote.
      // Must happen after the write: setSessionFile loads the file if it exists, which
      // marks the manager flushed. Reverse the order and the first assistant reply hits
      // _persist's "wx" open on a file that now exists, and throws EEXIST.
      // The cast is safe: ReadonlySessionManager only removes the setters at compile
      // time, the object handed to extensions is the real SessionManager.
      (ctx.sessionManager as SessionManager).setSessionFile(targetSessionFilePath);
      logDebug(`[Step 6] Switched session to: ${ctx.sessionManager.getSessionFile()}`);

    } catch (error: any) {
      logDebug(`[ERROR] Heist failed: ${error.message}\n${error.stack}`);
      ctx.ui.notify(`Heist failed: ${error.message}`, "error");
    }

    logDebug(`=== Heist Sequence Complete. Canceling native fork. ===\n`);
    // Crucial: Cancel the native fork, because we just executed the cross-directory Heist manually!
    return { cancel: true };
  });
}
