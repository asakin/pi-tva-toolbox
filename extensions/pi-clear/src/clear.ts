/**
 * pi-clear — /clear as the counter to /new, the way /tree is the counter to /fork.
 *
 * Claude's /clear wipes context and strands the old conversation in a saved
 * file. Pi has /new for that already. This /clear rewinds the CURRENT session
 * tree to before its first user message and grows a new branch from there:
 * the context is genuinely cleared, but the old timeline stays in the tree,
 * one /tree jump away.
 *
 * The "⌛ clear HH:MM" label always hangs on the first user message — the
 * session's seed prompt, and the one entry that always exists. The old
 * branch keeps it as a scar; the new branch re-sends the same prompt, so the
 * marker belongs to the event more than to either side. The HH:MM keeps
 * repeated clears in a session distinguishable and self-ordering (/tree's
 * Shift+T carries the full timestamp).
 *
 * ctx.navigateTree implements native /tree selection semantics for a
 * user-message target: the leaf moves to the message's parent (an empty
 * conversation), or resets to before-all-entries when the message is the
 * root, the label attaches to the message, and the original prompt is handed
 * back for the editor — the session's intent stays one Enter away.
 */

import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type UserMsg = Extract<SessionMessageEntry["message"], { role: "user" }>;

const CLEAR_LABEL_PREFIX = "⌛ clear";

// UserMessage.content is string | (TextContent | ImageContent)[]. Text parts
// only, so an image in the message is dropped rather than stringified.
function userMessageText(message: UserMsg): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Rewind this session to before its first message as a new tree branch (the old timeline stays in /tree)",
		handler: async (_args, ctx) => {
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("clear: this session has no entries yet.", "info");
				return;
			}

			// Walk the current branch leaf → root (read-only), keeping the
			// earliest user message found.
			let firstUser: { id: string; parentId: string | null; message: UserMsg } | null = null;
			let cursor: string | null = leafId;
			while (cursor) {
				const entry = ctx.sessionManager.getEntry(cursor);
				if (!entry) break;
				if (entry.type === "message" && entry.message.role === "user") {
					firstUser = { id: entry.id, parentId: entry.parentId, message: entry.message };
				}
				cursor = entry.parentId;
			}
			if (!firstUser) {
				ctx.ui.notify("clear: no user message on this branch — nothing to rewind to.", "warning");
				return;
			}

			if (firstUser.id === leafId || firstUser.parentId === leafId) {
				ctx.ui.notify("clear: already at the beginning of this branch.", "info");
				return;
			}

			// Targeting the first user message — the one entry that always
			// exists — gives "before" semantics every time: the leaf moves to
			// its parent (or resets when it is the root), the label lands on
			// the seed prompt, and pi hands the prompt back for the editor.
			// summarize stays off — a clear clear, no residue.
			const result = await ctx.navigateTree(firstUser.id, {
				summarize: false,
				label: `${CLEAR_LABEL_PREFIX} ${new Date().toTimeString().slice(0, 5)}`,
			});
			if (result.cancelled) return;

			// The interactive runtime applies the returned editor text itself;
			// setting it again is idempotent and covers runtimes that don't.
			const text = userMessageText(firstUser.message);
			if (text) ctx.ui.setEditorText(text);

			ctx.ui.notify("Timeline cleared — the seed prompt is labeled in /tree.", "info");
		},
	});
}
