import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

// Set by the fork hook, consumed by /graft-finish.
//
// Survives the fork because pi caches extension factories per cwd
// (extensions/loader.js:111-125) and forking does not change cwd, so the module
// is never re-executed. It is dropped on /reload or once the cwd does change,
// which is why /graft-finish falls back to asking rather than trusting it.
let pendingTargetDir: string | null = null;

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

// Interactive directory browser. Returns undefined if the user escapes.
async function pickDirectory(ctx: Pick<ExtensionContext, "ui">, startDir: string) {
  const home = os.homedir();
  let currentDir = startDir;

  while (true) {
    const dirs = await getSubdirectories(currentDir);

    // Only collapse a leading home path, not one appearing mid-string.
    const inHome = currentDir === home || currentDir.startsWith(home + path.sep);
    const displayPath = inHome ? "~" + currentDir.slice(home.length) : currentDir;

    const choices = [GRAFT_HERE, GO_UP, GO_HOME, ...dirs];
    const selection = await ctx.ui.select(`Time Heist - target: ${displayPath}`, choices);

    if (!selection) return undefined;

    if (selection === GRAFT_HERE) {
      return currentDir;
    } else if (selection === GO_UP) {
      currentDir = path.dirname(currentDir);
    } else if (selection === GO_HOME) {
      currentDir = home;
    } else {
      // Navigating into a subdirectory
      currentDir = path.join(currentDir, selection.replace("/", ""));
    }
  }
}

export default function (pi: ExtensionAPI) {
  // 1. Ask where this fork should land, then step aside.
  //
  // We do NOT cancel. Pi runs its own fork, which extracts the branch correctly
  // (honouring event.position) and rebuilds the runtime properly. All this hook
  // does is remember where the user wants it to end up.
  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    logDebug(`\n=== T.V.A. Time Heist Initiated ===`);
    logDebug(`[Step 0] Forking from entryId: ${event.entryId} in ${ctx.cwd}`);

    const targetDir = await pickDirectory(ctx, ctx.cwd);
    if (targetDir === undefined) {
      logDebug(`[Step 1] Aborted`);
      ctx.ui.notify("Heist aborted.", "warning");
      return { cancel: true };
    }

    if (targetDir === ctx.cwd) {
      logDebug(`[Step 1] Same directory, plain fork.`);
      return;
    }

    pendingTargetDir = targetDir;
    logDebug(`[Step 1] Target staged: ${targetDir}`);
    return;
  });

  // 2. The fork has landed. Tell the user how to finish the move.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "fork" || !pendingTargetDir) return;

    logDebug(`[Step 2] Fork landed at ${ctx.sessionManager.getSessionFile()}`);
    ctx.ui.notify(`Forked. Run /graft-finish to move it to ${pendingTargetDir}`, "info");
  });

  // 3. Copy this session into the target directory and switch to the copy.
  //
  // Only a command handler receives an ExtensionCommandContext, and that is the
  // only context carrying switchSession. That is the whole reason this is a
  // second step instead of part of the hook above.
  pi.registerCommand("graft-finish", {
    description: "Move the current session into the directory chosen during fork",
    handler: async (args, ctx) => {
      const targetDir = pendingTargetDir ?? (await pickDirectory(ctx, ctx.cwd));
      pendingTargetDir = null;

      if (targetDir === undefined) {
        ctx.ui.notify("Heist aborted.", "warning");
        return;
      }

      if (targetDir === ctx.cwd) {
        ctx.ui.notify("Already in that directory.", "warning");
        return;
      }

      try {
        await fs.mkdir(targetDir, { recursive: true });

        // Pi already built the branch when it forked, so the live session's
        // entries are exactly what we want. No walking, no splicing.
        const entries = ctx.sessionManager.getEntries();
        logDebug(`[Step 3] Moving ${entries.length} entries to ${targetDir}`);

        // create() takes cwd first, so the header is stamped with the target
        // directory. sessionDir is explicit because the default resolves against
        // the process agent dir, which is wrong under a relocated one.
        const targetSessionDir = path.join(
          path.dirname(ctx.sessionManager.getSessionDir()),
          `--${targetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
        );
        const targetManager = SessionManager.create(targetDir, targetSessionDir, {
          parentSession: ctx.sessionManager.getSessionFile(),
        });

        const targetFile = targetManager.getSessionFile()!;
        const lines = [targetManager.getHeader()!, ...entries].map((e) => JSON.stringify(e));
        await fs.writeFile(targetFile, lines.join("\n") + "\n", "utf-8");
        logDebug(`[Step 4] Wrote ${targetFile}`);

        // switchSession opens the file, so it must exist first. It reads cwd from
        // the header we just wrote, and that is what actually moves us.
        const result = await ctx.switchSession(targetFile, {
          withSession: async (newCtx) => {
            newCtx.ui.notify(`Sacred Timeline grafted into ${targetDir}`, "info");
          },
        });

        if (result.cancelled) {
          logDebug(`[Step 5] Switch cancelled`);
          ctx.ui.notify("Graft cancelled during switch.", "warning");
          return;
        }
        logDebug(`[Step 5] Switched to ${targetFile}\n`);
      } catch (error: any) {
        logDebug(`[ERROR] Heist failed: ${error.message}\n${error.stack}`);
        ctx.ui.notify(`Heist failed: ${error.message}`, "error");
      }
    },
  });
}
