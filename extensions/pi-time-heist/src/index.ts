import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createLogger } from "../../../lib/tva-log.ts";

const logDebug = createLogger("HEIST");

// Browser menu entries.
const GRAFT_HERE = "[ graft here ]";
const GO_HOME = "~/";
const GO_UP = "../";

// Mirrors pi's own extractUserMessageText, which is internal. Text parts only,
// so an image in the forked message is dropped rather than stringified.
export function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function displayPath(dir: string): string {
  const home = os.homedir();
  // Only collapse a leading home path, not one appearing mid-string.
  const inHome = dir === home || dir.startsWith(home + path.sep);
  return inHome ? "~" + dir.slice(home.length) : dir;
}

// Locked by the fork hook, spent by /heist. Module state survives the gap
// because cancelling the native fork means nothing is ever torn down.
type PendingHeist = {
  targetDir: string;
  entryId: string;
  position: "before" | "at";
  sessionId: string;
};
let pendingHeist: PendingHeist | null = null;

export async function getSubdirectories(currentPath: string): Promise<string[]> {
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

// "at" keeps the selected message, "before" starts from its parent --
// matching what Pi's own fork does with event.position. Root-first order.
export function reconstructBranch(
  entries: SessionEntry[],
  selected: SessionEntry,
  position: "before" | "at"
): SessionEntry[] {
  const parentMap = new Map(entries.map((e) => [e.id, e]));
  const branchEntries: SessionEntry[] = [];
  let currentId = position === "at" ? selected.id : selected.parentId;
  while (currentId) {
    const entry = parentMap.get(currentId);
    if (!entry) break;
    branchEntries.unshift(entry); // Add to front for chronological order
    currentId = entry.parentId;
  }
  return branchEntries;
}

export default function (pi: ExtensionAPI) {
  // Hook into the native fork process BEFORE it executes
  pi.on("session_before_fork", async (event, ctx) => {
    const home = os.homedir();
    let currentDir = ctx.cwd;
    let absoluteTargetDir: string | undefined;

    logDebug(`\n=== T.V.A. Time Heist Initiated ===`);
    logDebug(`[Step 0] Forking ${event.position} entry ${event.entryId} in ${ctx.cwd}`);

    // 1. Interactive Directory Browser
    while (true) {
      const dirs = await getSubdirectories(currentDir);

      const choices = [GRAFT_HERE, GO_HOME, GO_UP, ...dirs];
      const selection = await ctx.ui.select(`Time Heist - target: ${displayPath(currentDir)}`, choices);

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

    // 2. Delegate to Native Fork
    // Same directory means there is nothing to move, so let Pi fork in place.
    if (absoluteTargetDir === ctx.cwd) {
      logDebug(`[Step 1] Same directory, deferring to native fork.`);
      return;
    }

    // 3. Lock the trajectory and hand off to /heist.
    // The switch itself needs switchSession, which only exists on a command
    // context -- so the hook captures what only it can see (entryId, position)
    // and the command spends it.
    pendingHeist = {
      targetDir: absoluteTargetDir,
      entryId: event.entryId,
      position: event.position,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    logDebug(`[Step 1] Locked target ${absoluteTargetDir}`);

    ctx.ui.notify(
      `Heist trajectory locked → ${displayPath(absoluteTargetDir)}\nType /heist to initiate the jump.`,
      "info"
    );

    return { cancel: true };
  });

  pi.registerCommand("heist", {
    description: "Complete a locked Time Heist: graft this branch into the target directory",
    handler: async (args, ctx) => {
      if (!pendingHeist) {
        ctx.ui.notify("No heist pending. Fork to a different directory first.", "warning");
        return;
      }

      const heist = pendingHeist;

      // The entry ids only mean anything in the session that produced them.
      if (heist.sessionId !== ctx.sessionManager.getSessionId()) {
        pendingHeist = null;
        logDebug(`[Abort] Heist locked in session ${heist.sessionId}, now in ${ctx.sessionManager.getSessionId()}`);
        ctx.ui.notify("Pending heist belongs to a different session. Discarded.", "warning");
        return;
      }

      logDebug(`[Step 2] Executing heist to ${heist.targetDir}`);

      try {
        // Pi refuses to open a session whose cwd is missing.
        await fs.mkdir(heist.targetDir, { recursive: true });

        const selected = ctx.sessionManager.getEntry(heist.entryId);
        if (!selected) {
          throw new Error(`Entry ${heist.entryId} is no longer in this session.`);
        }

        const branchEntries = reconstructBranch(
          ctx.sessionManager.getEntries(),
          selected,
          heist.position
        );
        logDebug(`[Step 3] Reconstructed branch history: ${branchEntries.length} entries`);

        // SessionManager.create takes the cwd first, so the header carries the
        // target directory. That header is the only way the destination cwd
        // reaches switchSession, which does not accept a cwd override.
        // sessionDir is explicit because the default resolves against the
        // process agent dir, wrong if pi booted with a relocated one.
        const targetSessionDir = path.join(
          path.dirname(ctx.sessionManager.getSessionDir()),
          `--${heist.targetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
        );
        const targetManager = SessionManager.create(heist.targetDir, targetSessionDir, {
          parentSession: ctx.sessionManager.getSessionFile(),
        });

        const targetSessionFile = targetManager.getSessionFile()!;
        const header = targetManager.getHeader()!;
        logDebug(`[Step 4] Created shell session ${header.id} at ${targetSessionFile}`);

        // Written directly rather than through appendMessage, which would re-id
        // every entry and break the parent chain.
        const splicedLines = [header, ...branchEntries].map((e) => JSON.stringify(e));
        await fs.writeFile(targetSessionFile, splicedLines.join("\n") + "\n", "utf-8");
        logDebug(`[Step 5] Wrote header + ${branchEntries.length} entries`);

        // Cleared before the switch: on the far side this context is dead, and a
        // failed jump should not leave entry ids from a session we may have left.
        pendingHeist = null;

        // Forking "before" a message leaves it out of the branch, so hand its
        // text back in the editor the way Pi's native fork does. "at" keeps the
        // message, so there is nothing to hand back.
        const selectedText =
          heist.position === "before" &&
          selected.type === "message" &&
          selected.message.role === "user"
            ? userMessageText(selected.message.content)
            : undefined;

        // switchSession reopens the file and rebuilds the runtime at the
        // header's cwd, which is what actually moves the working directory.
        const result = await ctx.switchSession(targetSessionFile, {
          withSession: async (nextCtx) => {
            // The editor belongs to the new session, so prefill on this side.
            if (selectedText) nextCtx.ui.setEditorText(selectedText);
            nextCtx.ui.notify(
              `Branch history grafted into ${displayPath(heist.targetDir)}`,
              "info"
            );
          },
        });
        logDebug(`[Step 6] switchSession cancelled=${result.cancelled}`);

        if (result.cancelled) {
          ctx.ui.notify("Heist switch was cancelled.", "warning");
        }
      } catch (error: any) {
        pendingHeist = null;
        logDebug(`[ERROR] Heist failed: ${error.message}\n${error.stack}`);
        ctx.ui.notify(`Heist failed: ${error.message}`, "error");
      }
    },
  });
}
