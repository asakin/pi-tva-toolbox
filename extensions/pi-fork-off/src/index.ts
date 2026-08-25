import type { ExtensionAPI, ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";

const MAX_BRANCHES = 20;

/**
 * A command's `ctx.sessionManager` is typed `ReadonlySessionManager` but is the full
 * SessionManager at runtime; this is the one place that widens it.
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
    return { error: `Too many slugs (${slugs.length}); max ${MAX_BRANCHES} branches.` };
  }
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) return { error: `Duplicate slug "${slug}".` };
    seen.add(slug);
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
 * Create one branch per slug, all forking from `baseId`, and leave the leaf on `baseId`.
 *
 * Each branch is `base -> head -> marker`. The head carries the branch brief; the marker
 * is the empty, labeled `custom_message` selected in /tree. Selecting a `custom_message`
 * moves the leaf to its parent and, since the marker text is empty, prefills nothing, so
 * selecting the marker lands on the head. A trailing `custom` entry on the base keeps the
 * file's last line, which is the persisted position, on the base rather than inside the last branch.
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

  // Record the fan-out on the base so the persisted position stays there.
  sessionManager.branch(baseId);
  sessionManager.appendCustomEntry("fork-off", {
    baseId,
    branches: branches.map(({ slug, headId, markerId }) => ({ slug, headId, markerId })),
  });

  return { branches };
}

// ui.notify is a no-op without a UI (print/json), so errors also go to stderr there.
function report(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
  ctx.ui.notify(message, level);
  if (!ctx.hasUI && level === "error") console.error(message);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-off", {
    description: "Fork the current point into several labeled branches to explore in parallel",
    handler: async (args: string, ctx) => {
      const parsed = parseSlugs(args);
      if ("error" in parsed) {
        report(ctx, parsed.error, "error");
        return;
      }

      const baseId = ctx.sessionManager.getLeafId();
      if (!baseId) {
        report(ctx, "Cannot branch from an empty session.", "error");
        return;
      }

      let branches: ForkOffResult["branches"];
      try {
        ({ branches } = forkOff(writable(ctx.sessionManager), baseId, parsed.slugs, new Date()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report(ctx, `fork-off failed: ${message}`, "error");
        return;
      }

      report(ctx, `Forked off ${branches.length} branches. Use /tree to walk into them.`, "info");
    },
  });
}
