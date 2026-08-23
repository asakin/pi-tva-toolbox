import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

const MAX_BRANCHES = 20;

/**
 * Pi types a command's `ctx.sessionManager` as `ReadonlySessionManager` (a Pick of the
 * getters), but the object passed at runtime is the full SessionManager. Writing to the
 * session from a command therefore needs one deliberate widening, here, rather than a
 * cast at every call site.
 */
function writable(sessionManager: unknown): SessionManager {
  return sessionManager as SessionManager;
}

export function parseSlugs(args: string): { slugs: string[] } | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "Usage: /fork-off <number> OR /fork-off <slug1> <slug2> ..." };
  }

  // A bare number always means "this many numbered branches", never a branch named "3".
  if (/^\d+$/.test(trimmed)) {
    const count = parseInt(trimmed, 10);
    if (count < 1 || count > MAX_BRANCHES) {
      return { error: `Count must be between 1 and ${MAX_BRANCHES}.` };
    }
    return { slugs: Array.from({ length: count }, (_, i) => `Branch ${i + 1}`) };
  }

  const slugs = trimmed.split(/\s+/);
  if (slugs.length > MAX_BRANCHES) {
    return { error: `Too many slugs (${slugs.length}) — max ${MAX_BRANCHES} branches.` };
  }
  return { slugs };
}

function clockLabel(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export interface ForkOffResult {
  /** One entry per branch, in the order the slugs were given. */
  branches: { slug: string; headId: string; markerId: string }[];
}

/**
 * Create one branch per slug, all forking from `baseId`, and leave the leaf back at
 * `baseId`.
 *
 * ## Why each branch is two entries
 *
 * Each branch is `base → head → marker`:
 *
 * - **head** carries the branch brief and is the node you actually work from.
 * - **marker** is the labeled node you select in `/tree`. Its content is empty.
 *
 * That shape exists because of how Pi navigates. `AgentSession.navigateTree()` treats a
 * `custom_message` exactly like a user message: selecting one means "rewind to before
 * this message and let me retype it", so it sets the new leaf to the selected entry's
 * **parent** and hands the entry's text back to the editor. A single labeled node per
 * branch would therefore send you to that node's parent — the shared base — which is the
 * opposite of entering the branch.
 *
 * With the marker one level below the head, that same rewind lands the leaf on the head:
 * inside the branch, with the brief in context. The marker's content is empty so nothing
 * is prefilled into the editor (Pi only prefills when the text is non-empty).
 *
 * The marker stays in the tree as that branch's signpost. It is never on the working
 * path, so its empty content never reaches the model.
 *
 * ## Why a trailing bookkeeping entry
 *
 * A session's persisted position is simply its last line: `SessionManager._buildIndex()`
 * assigns the leaf while replaying entries in file order, and `branch()` moves the
 * in-memory leaf while writing nothing. Without a final entry on the base path, the last
 * line of the file belongs to the last branch created — so resuming the session would
 * silently drop you inside that branch. The trailing `custom` entry is a child of the
 * base, which puts the persisted position back on the trunk. Plain `custom` entries are
 * excluded from LLM context and hidden from `/tree`'s default view.
 */
export function forkOff(
  sessionManager: SessionManager,
  baseId: string,
  slugs: string[],
  now: Date,
): ForkOffResult {
  const timestamp = clockLabel(now);
  const branches: ForkOffResult["branches"] = [];

  for (const slug of slugs) {
    sessionManager.branch(baseId);

    const headId = sessionManager.appendCustomMessageEntry(
      "fork-off",
      `You are on branch "${slug}", one of ${slugs.length} forked from this point. ` +
        `Work only on this branch. Wait for the user.`,
      false,
    );

    const markerId = sessionManager.appendCustomMessageEntry("fork-off", "", false);
    sessionManager.appendLabelChange(markerId, `🔀 ${timestamp} ${slug}`);

    branches.push({ slug, headId, markerId });
  }

  // Return to the base and record the fan-out there, so the persisted position is on the
  // trunk rather than inside the last branch.
  sessionManager.branch(baseId);
  sessionManager.appendCustomEntry("fork-off", {
    baseId,
    branches: branches.map(({ slug, headId, markerId }) => ({ slug, headId, markerId })),
  });

  return { branches };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-off", {
    description: "Fork the current point into several labeled branches to explore in parallel",
    handler: async (args: string, ctx) => {
      const parsed = parseSlugs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const baseId = ctx.sessionManager.getLeafId();
      if (!baseId) {
        ctx.ui.notify("Cannot branch from an empty session.", "error");
        return;
      }

      const { branches } = forkOff(writable(ctx.sessionManager), baseId, parsed.slugs, new Date());

      ctx.ui.notify(`Forked off ${branches.length} branches. Use /tree to walk into them.`, "info");
    },
  });
}
