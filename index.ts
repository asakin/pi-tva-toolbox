import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
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
    // Report rather than swallow, but never let a bad log path kill the graft.
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

// Interactive Directory Browser
async function pickDirectory(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const home = os.homedir();
  let currentDir = ctx.cwd;

  while (true) {
    const dirs = await getSubdirectories(currentDir);

    // Only collapse a leading home path, not one appearing mid-string.
    const inHome = currentDir === home || currentDir.startsWith(home + path.sep);
    const displayPath = inHome ? "~" + currentDir.slice(home.length) : currentDir;

    const choices = [GRAFT_HERE, GO_UP, GO_HOME, ...dirs];
    const selection = await ctx.ui.select(`Time Heist - target: ${displayPath}`, choices);

    // User hit escape or cancelled
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

function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

// Message content is either a plain string or a list of content blocks. Bash
// execution messages carry no content at all.
function messageText(entry: SessionMessageEntry): string {
  if (!("content" in entry.message)) return "";
  const content: unknown = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join(" ");
}

// Stands in for pi's own fork selector, which is internal to the TUI and not
// reachable from an extension.
async function pickEntry(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const userEntries = ctx.sessionManager.getEntries().filter(isUserMessage);

  if (userEntries.length === 0) {
    ctx.ui.notify("No messages to graft from.", "warning");
    return undefined;
  }

  // The number prefix keeps labels unique, so indexOf maps back to the right entry.
  const labels = userEntries.map((entry, i) => {
    const text = messageText(entry).replace(/\s+/g, " ").trim();
    return `${i + 1}. ${text.slice(0, 70)}${text.length > 70 ? "..." : ""}`;
  });

  const selection = await ctx.ui.select("Graft the timeline up to:", labels);
  if (!selection) return undefined;

  return userEntries[labels.indexOf(selection)]?.id;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("graft", {
    description: "Graft this timeline into another directory",
    handler: async (args, ctx) => {
      logDebug(`\n=== T.V.A. Time Heist Initiated ===`);

      // 1. Choose the point in the timeline to graft up to, inclusive.
      const entryId = await pickEntry(ctx);
      if (!entryId) {
        logDebug(`[Step 1] Aborted at entry selection.`);
        return;
      }
      logDebug(`[Step 1] Grafting up to entryId: ${entryId}`);

      // 2. Choose the destination directory.
      const targetDir = await pickDirectory(ctx);
      if (!targetDir) {
        logDebug(`[Step 2] Aborted at directory selection.`);
        return;
      }
      logDebug(`[Step 2] Target directory: ${targetDir}`);

      try {
        // Ensure the target exists, so Pi can bind the workspace to it.
        await fs.mkdir(targetDir, { recursive: true });

        // 3. Walk backward from the selected entry to the root.
        const entries = ctx.sessionManager.getEntries();
        const parentMap = new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
        const branchEntries: SessionEntry[] = [];

        let currentId: string | null = entryId;
        while (currentId !== null) {
          const entry: SessionEntry | undefined = parentMap.get(currentId);
          if (!entry) break;
          branchEntries.unshift(entry); // Add to front for chronological order
          currentId = entry.parentId;
        }
        logDebug(`[Step 3] Reconstructed branch history: ${branchEntries.length} entries`);

        ctx.ui.notify(`Grafting timeline to ${targetDir}...`, "info");

        // 4. Build the shell session for the target directory.
        // SessionManager.create takes the cwd as its first argument, so the header is
        // stamped with the target directory. It mints the UUID, the filename and the
        // parentSession link. sessionDir is passed explicitly because the default
        // resolves against the process agent dir, which is wrong under a relocated one.
        const targetSessionDir = path.join(
          path.dirname(ctx.sessionManager.getSessionDir()),
          `--${targetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
        );
        const targetManager = SessionManager.create(targetDir, targetSessionDir, {
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

        // 6. Hand over to Pi's own resume path. switchSession reopens the file, reads
        // the target cwd out of the header, and rebuilds the runtime around it. That
        // rebuild is what setSessionFile could never do from a hook.
        const result = await ctx.switchSession(targetSessionFilePath, {
          withSession: async (newCtx) => {
            newCtx.ui.notify(`Sacred Timeline grafted into ${targetDir}`, "info");
          },
        });

        if (result.cancelled) {
          logDebug(`[Step 6] Switch cancelled.`);
          ctx.ui.notify("Graft cancelled during session switch.", "warning");
          return;
        }
        logDebug(`[Step 6] Switched session to: ${targetSessionFilePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDebug(`[ERROR] Heist failed: ${message}`);
        ctx.ui.notify(`Heist failed: ${message}`, "error");
      }
    },
  });
}
