/**
 * pi-clear — /clear as the counter to /new, the way /tree is the counter to /fork.
 *
 * Claude's /clear wipes context and strands the old conversation in a saved
 * file. Pi has /new for that already. This /clear rewinds the CURRENT session
 * tree to before its first user message and grows a new branch from there:
 * the context is genuinely cleared, but the old timeline stays in the tree,
 * one /tree jump away.
 *
 * The "⌛ clear HH:MM" label marks the ARRIVAL, not the departure: it hangs on
 * the junction entry at the base of the NEW branch — a timeline jump happened
 * before this point, at this time. The old branch gets nothing: what it was
 * and why we left it is not ours to assert. The HH:MM keeps repeated clears
 * in a session distinguishable and self-ordering (/tree's Shift+T carries the
 * full timestamp).
 *
 * ctx.navigateTree implements native /tree selection semantics. For a
 * user-message target the leaf moves to the message's parent — but the label
 * would attach to that message, the old branch's start, the wrong side. So
 * when the first message has a parent, the target is the PARENT (a non-user
 * entry): the leaf lands on the junction and the label lands with it, and the
 * editor text is set by hand (non-user targets produce none). When the first
 * message is the tree root there is no junction entry — the new branch has no
 * base to mark, so that jump is unlabeled by construction.
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

			if (firstUser.parentId === null) {
				// Root first message: no junction entry exists, so the new
				// branch has no base to label. Targeting the message itself
				// resets the leaf before all entries and pi hands the prompt
				// back to the editor.
				const result = await ctx.navigateTree(firstUser.id, { summarize: false });
				if (result.cancelled) return;
			} else {
				// Junction exists: target the parent (a non-user entry). The
				// leaf lands at the base of the NEW branch and the label lands
				// with it; the old branch stays unmarked. Non-user targets
				// produce no editor text, so the prompt is set by hand.
				const result = await ctx.navigateTree(firstUser.parentId, {
					summarize: false,
					label: `${CLEAR_LABEL_PREFIX} ${new Date().toTimeString().slice(0, 5)}`,
				});
				if (result.cancelled) return;

				const text = userMessageText(firstUser.message);
				if (text) ctx.ui.setEditorText(text);
			}

			ctx.ui.notify("Timeline cleared — the jump point is labeled in /tree.", "info");
		},
	});
}
