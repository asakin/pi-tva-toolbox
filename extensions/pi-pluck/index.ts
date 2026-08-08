import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
/** SessionManager is typed read-only on ctx; runtime instance still has mutators we need. */
type MutableSessionManager = {
	getEntries(): SessionEntry[];
	branch(branchFromId: string): void;
	_appendEntry(entry: SessionEntry): void;
};

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/** Match corpus: user text, assistant text, tool call name+args. Never tool results. */
function entryMatchText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const msg = entry.message;
	if (msg.role === "toolResult") return "";
	if (msg.role === "user") return contentToText(msg.content);
	if (msg.role === "assistant") {
		const parts: string[] = [];
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as {
				type?: string;
				text?: string;
				name?: string;
				arguments?: unknown;
			};
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			if (b.type === "toolCall") {
				if (typeof b.name === "string") parts.push(b.name);
				try {
					parts.push(JSON.stringify(b.arguments ?? {}));
				} catch {
					parts.push(String(b.arguments));
				}
			}
		}
		return parts.join("\n");
	}
	return "";
}

function turnMatches(turn: SessionEntry[], regex: RegExp): boolean {
	for (const entry of turn) {
		const text = entryMatchText(entry);
		if (text && regex.test(text)) return true;
	}
	return false;
}

function chunkTurns(path: SessionEntry[]): SessionEntry[][] {
	const turns: SessionEntry[][] = [];
	let currentTurn: SessionEntry[] = [];
	for (const entry of path) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (currentTurn.length > 0) turns.push(currentTurn);
			currentTurn = [];
		}
		currentTurn.push(entry);
	}
	if (currentTurn.length > 0) turns.push(currentTurn);
	return turns;
}

function findFirstUserEntry(path: SessionEntry[]): SessionMessageEntry | null {
	for (const entry of path) {
		if (entry.type === "message" && entry.message.role === "user") {
			return entry;
		}
	}
	return null;
}

function nextId(usedIds: Set<string>): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!usedIds.has(id)) {
			usedIds.add(id);
			return id;
		}
	}
	const id = randomUUID();
	usedIds.add(id);
	return id;
}

function remapClonedEntry(
	entry: SessionEntry,
	idMap: Map<string, string>,
	divergenceParentId: string,
): SessionEntry {
	const clone = JSON.parse(JSON.stringify(entry)) as SessionEntry;
	const newId = idMap.get(entry.id);
	if (!newId) throw new Error(`pluck: missing id map for ${entry.id}`);
	clone.id = newId;
	if (entry.parentId && idMap.has(entry.parentId)) {
		clone.parentId = idMap.get(entry.parentId)!;
	} else {
		clone.parentId = divergenceParentId;
	}

	if (clone.type === "compaction" && clone.firstKeptEntryId) {
		const mapped = idMap.get(clone.firstKeptEntryId);
		if (mapped) clone.firstKeptEntryId = mapped;
	}
	if (clone.type === "branch_summary" && clone.fromId) {
		const mapped = idMap.get(clone.fromId);
		if (mapped) clone.fromId = mapped;
	}
	if (clone.type === "label" && clone.targetId) {
		const mapped = idMap.get(clone.targetId);
		if (mapped) clone.targetId = mapped;
	}
	return clone;
}

function buildConfirmMessage(opts: {
	regexStr: string;
	skippedCount: number;
	keptTurnCount: number;
	rootProtected: boolean;
	labelOnly: boolean;
}): string {
	const stay = "You stay on the current branch; jump via /tree when you want.";
	if (opts.rootProtected) {
		const extra =
			opts.skippedCount > 1
				? ` Also pluck ${opts.skippedCount - 1} other matching turn(s).`
				: "";
		const keep = opts.labelOnly
			? " Forgetful branch will be label-only off the initial prompt."
			: ` Forgetful branch keeps ${opts.keptTurnCount} turn(s) after that.`;
		return (
			`Will keep the initial user prompt and forget the first assistant answer (+ tools).` +
			`${extra}${keep} ${stay}`
		);
	}
	const keep = opts.labelOnly
		? "Forgetful branch will be label-only (nothing left to keep after the cut)."
		: `Keep ${opts.keptTurnCount} turn(s) on the forgetful branch.`;
	return (
		`Pluck ${opts.skippedCount} turn(s) matching /${opts.regexStr}/. ${keep} ${stay}`
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pluck", {
		description:
			"Create a labeled forgetful side-branch omitting turns that match a regex (does not switch to it)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const regexStr = args.trim();
			if (!regexStr) {
				ctx.ui.notify("Usage: /pluck <regex>", "error");
				return;
			}

			let regex: RegExp;
			try {
				regex = new RegExp(regexStr, "i");
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Invalid regex: ${message}`, "error");
				return;
			}

			const originalLeafId = ctx.sessionManager.getLeafId();
			if (!originalLeafId) {
				ctx.ui.notify("pluck: this session has no entries yet.", "info");
				return;
			}

			const path = ctx.sessionManager.getBranch();
			const turns = chunkTurns(path);
			const firstUser = findFirstUserEntry(path);

			const keptTurns: SessionEntry[][] = [];
			let skippedCount = 0;
			let rootProtected = false;

			for (const turn of turns) {
				if (!turnMatches(turn, regex)) {
					keptTurns.push(turn);
					continue;
				}

				skippedCount++;
				const userIdx = firstUser
					? turn.findIndex((e) => e.id === firstUser.id)
					: -1;

				if (userIdx >= 0 && !rootProtected) {
					// Never drop the initial user prompt; forget only the assistant cycle under it.
					rootProtected = true;
					keptTurns.push(turn.slice(0, userIdx + 1));
				}
			}

			if (skippedCount === 0) {
				ctx.ui.notify(
					`No turns matched regex /${regexStr}/. Nothing to pluck.`,
					"info",
				);
				return;
			}

			const keptFlat = keptTurns.flat();
			let sharedLen = 0;
			while (
				sharedLen < keptFlat.length &&
				sharedLen < path.length &&
				keptFlat[sharedLen]!.id === path[sharedLen]!.id
			) {
				sharedLen++;
			}

			const toClone = keptFlat.slice(sharedLen);
			const divergenceParentId =
				sharedLen > 0 ? keptFlat[sharedLen - 1]!.id : null;
			const labelOnly = toClone.length === 0;

			if (!divergenceParentId) {
				ctx.ui.notify(
					"pluck: nowhere to hang the forgetful branch (no shared prefix).",
					"error",
				);
				return;
			}

			const keptTurnCount = keptTurns.length;
			const labelTime = new Date().toTimeString().slice(0, 5);
			const labelText = `plucked /${regexStr}/ ${labelTime}`;

			const confirmed = await ctx.ui.confirm(
				"Create forgetful branch?",
				buildConfirmMessage({
					regexStr,
					skippedCount,
					keptTurnCount,
					rootProtected,
					labelOnly,
				}),
			);
			if (!confirmed) {
				ctx.ui.notify("pluck: aborted.", "info");
				return;
			}

			const sm = ctx.sessionManager as unknown as MutableSessionManager;
			const usedIds = new Set(sm.getEntries().map((e: SessionEntry) => e.id));
			const idMap = new Map<string, string>();
			for (const entry of toClone) {
				idMap.set(entry.id, nextId(usedIds));
			}

			const clones: SessionEntry[] = toClone.map((entry) =>
				remapClonedEntry(entry, idMap, divergenceParentId),
			);

			try {
				sm.branch(divergenceParentId);
				for (const entry of clones) {
					sm._appendEntry(entry);
				}
				const tipId =
					clones.length > 0 ? clones[clones.length - 1]!.id : divergenceParentId;
				pi.setLabel(tipId, labelText);
				sm.branch(originalLeafId);
			} catch (err: unknown) {
				try {
					sm.branch(originalLeafId);
				} catch {
					/* best-effort restore */
				}
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`pluck failed: ${message}`, "error");
				return;
			}

			ctx.ui.notify(
				`Created forgetful branch "${labelText}" (${skippedCount} turn(s) plucked). Still on current branch.`,
				"info",
			);
		},
	});
}
