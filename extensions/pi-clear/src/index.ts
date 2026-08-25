/**
 * /clear rewinds the active branch to before its first user message and starts
 * a new branch there. The old branch stays in /tree, labeled "⌛ clear HH:MM"
 * on its first user message (a repeated /clear replaces that label). The
 * editor is left empty; summarize is off.
 */

import type { ExtensionAPI, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type UserMsg = Extract<SessionMessageEntry["message"], { role: "user" }>;

const CLEAR_LABEL_PREFIX = "⌛ clear";

export type FirstUser = { id: string; parentId: string | null; message: UserMsg };

// Walk leaf to root and keep the earliest user message; null when there is none.
export function findFirstUser(
	leafId: string,
	getEntry: (id: string) => SessionEntry | undefined
): FirstUser | null {
	let firstUser: FirstUser | null = null;
	let cursor: string | null = leafId;
	while (cursor) {
		const entry = getEntry(cursor);
		if (!entry) break;
		if (entry.type === "message" && entry.message.role === "user") {
			firstUser = { id: entry.id, parentId: entry.parentId, message: entry.message };
		}
		cursor = entry.parentId;
	}
	return firstUser;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Rewind this session to before its first message as a new branch (the old branch stays in /tree)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("clear: wait for the agent to finish its turn.", "warning");
				return;
			}

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("clear: this session has no entries yet.", "info");
				return;
			}

			const firstUser = findFirstUser(leafId, (id) => ctx.sessionManager.getEntry(id));
			if (!firstUser) {
				ctx.ui.notify("clear: no user message on this branch, nothing to rewind to.", "warning");
				return;
			}

			if (firstUser.id === leafId) {
				ctx.ui.notify("clear: already at the beginning of this branch.", "info");
				return;
			}

			// Selecting a user message moves the leaf to its parent and labels the message.
			let result: { cancelled: boolean };
			try {
				result = await ctx.navigateTree(firstUser.id, {
					summarize: false,
					label: `${CLEAR_LABEL_PREFIX} ${new Date().toTimeString().slice(0, 5)}`,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`clear failed: ${message}`, "error");
				return;
			}
			if (result.cancelled) return;

			// Native /tree selection would hand the prompt back to the editor; /clear does not.
			ctx.ui.setEditorText("");

			ctx.ui.notify("Cleared. The old branch is still in /tree.", "info");
		},
	});
}
