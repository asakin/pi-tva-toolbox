import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createLogger } from "@arielsakin/pi-tva-lib";

const logDebug = createLogger("HEIST");

// Browser menu entries.
const FORK_HERE = "[ fork here ]";
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

// Set by the fork hook, consumed by /heist. Module state carries it across
// the gap because cancelling the native fork tears nothing down.
type PendingHeist = {
  targetDir: string;
  entryId: string;
  position: "before" | "at";
  sessionId: string;
};
let pendingHeist: PendingHeist | null = null;

// Visible subdirectories only, sorted, with a trailing slash for the menu.
export async function getSubdirectories(currentPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name + "/");
    return dirs.sort();
  } catch {
    return [];
  }
}

// "at" keeps the selected message, "before" starts from its parent, matching
// what pi's own fork does with event.position. Root-first order.
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
    branchEntries.unshift(entry);
    currentId = entry.parentId;
  }
  return branchEntries;
}

// Session store for the target cwd. With pi's default store, pi encodes the
// target cwd itself; with a custom --session-dir, the new session stays in
// that directory, as pi's own /new does. The read-only context type omits
// usesDefaultSessionDir, but the runtime object is pi's SessionManager.
export function targetSessionDir(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
  const probe = sessionManager as Partial<Pick<SessionManager, "usesDefaultSessionDir">>;
  const usesDefault = typeof probe.usesDefaultSessionDir === "function" ? probe.usesDefaultSessionDir() : true;
  return usesDefault ? undefined : sessionManager.getSessionDir();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const home = os.homedir();
    let currentDir = ctx.cwd;
    let targetDir: string | undefined;

    logDebug("=== fork to another directory ===");
    logDebug(`fork ${event.position} entry ${event.entryId} in ${ctx.cwd}`);

    while (true) {
      const dirs = await getSubdirectories(currentDir);
      const choices = [FORK_HERE, GO_HOME, GO_UP, ...dirs];
      const selection = await ctx.ui.select(`Fork into: ${displayPath(currentDir)}`, choices);

      if (!selection) {
        logDebug(`cancelled at ${currentDir}`);
        ctx.ui.notify("Fork cancelled.", "warning");
        return { cancel: true };
      }

      if (selection === FORK_HERE) {
        targetDir = currentDir;
        break;
      } else if (selection === GO_UP) {
        currentDir = path.dirname(currentDir);
      } else if (selection === GO_HOME) {
        currentDir = home;
      } else {
        currentDir = path.join(currentDir, selection.replace("/", ""));
      }
    }

    // Same directory: nothing to move, so pi forks in place.
    if (targetDir === ctx.cwd) {
      logDebug("same directory, deferring to native fork");
      return;
    }

    // switchSession only exists on a command context, so the hook records what
    // only it can see (entryId, position) and /heist performs the switch.
    pendingHeist = {
      targetDir,
      entryId: event.entryId,
      position: event.position,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    logDebug(`target ${targetDir}`);

    ctx.ui.notify(`Target: ${displayPath(targetDir)}. Run /heist to fork there.`, "info");

    return { cancel: true };
  });

  pi.registerCommand("heist", {
    description: "Fork the pending branch into the chosen directory",
    handler: async (args, ctx) => {
      if (!pendingHeist) {
        ctx.ui.notify("No fork pending. Fork to a different directory first.", "warning");
        return;
      }

      const heist = pendingHeist;

      // The entry ids only mean anything in the session that produced them.
      if (heist.sessionId !== ctx.sessionManager.getSessionId()) {
        pendingHeist = null;
        logDebug(`discarded: target set in session ${heist.sessionId}, now in ${ctx.sessionManager.getSessionId()}`);
        ctx.ui.notify("Pending fork belongs to a different session. Discarded.", "warning");
        return;
      }

      logDebug(`forking into ${heist.targetDir}`);

      try {
        // The browser only offers existing directories and nothing is created
        // inside the target; it may have been removed since it was chosen.
        await fs.access(heist.targetDir).catch(() => {
          throw new Error(`Target directory no longer exists: ${heist.targetDir}`);
        });

        const selected = ctx.sessionManager.getEntry(heist.entryId);
        if (!selected) {
          throw new Error(`Entry ${heist.entryId} is no longer in this session.`);
        }

        const branchEntries = reconstructBranch(ctx.sessionManager.getEntries(), selected, heist.position);
        logDebug(`branch: ${branchEntries.length} entries`);

        // SessionManager.create takes the cwd first, so the header carries the
        // target directory. That header is the only way the destination cwd
        // reaches switchSession, which does not accept a cwd override.
        const targetManager = SessionManager.create(heist.targetDir, targetSessionDir(ctx.sessionManager), {
          parentSession: ctx.sessionManager.getSessionFile(),
        });

        const targetSessionFile = targetManager.getSessionFile()!;
        const header = targetManager.getHeader()!;
        logDebug(`new session ${header.id} at ${targetSessionFile}`);

        // Written directly rather than through appendMessage, which would re-id
        // every entry and break the parent chain.
        const splicedLines = [header, ...branchEntries].map((e) => JSON.stringify(e));
        await fs.writeFile(targetSessionFile, splicedLines.join("\n") + "\n", "utf-8");
        logDebug(`wrote header + ${branchEntries.length} entries`);

        // Cleared before the switch: on the far side this context is gone, and
        // a failed switch should not keep entry ids from a session we may have left.
        pendingHeist = null;

        // Forking "before" a message leaves it out of the branch, so hand its
        // text back in the editor the way pi's native fork does. "at" keeps the
        // message, so there is nothing to hand back.
        const selectedText =
          heist.position === "before" && selected.type === "message" && selected.message.role === "user"
            ? userMessageText(selected.message.content)
            : undefined;

        // switchSession reopens the file and rebuilds the runtime at the
        // header's cwd, which is what actually moves the working directory.
        const result = await ctx.switchSession(targetSessionFile, {
          withSession: async (nextCtx) => {
            // The editor belongs to the new session, so prefill on this side.
            if (selectedText) nextCtx.ui.setEditorText(selectedText);
            nextCtx.ui.notify(`Forked into ${displayPath(heist.targetDir)}`, "info");
          },
        });
        logDebug(`switchSession cancelled=${result.cancelled}`);

        if (result.cancelled) {
          ctx.ui.notify("Session switch was cancelled.", "warning");
        }
      } catch (error: any) {
        pendingHeist = null;
        logDebug(`fork failed: ${error.message}\n${error.stack}`);
        ctx.ui.notify(`Fork failed: ${error.message}`, "error");
      }
    },
  });
}
