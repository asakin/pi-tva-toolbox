import { randomUUID } from "node:crypto";
import type {
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export function contentToText(content: unknown): string {
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
export function entryMatchText(entry: SessionEntry): string {
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

export function turnMatches(turn: SessionEntry[], regex: RegExp): boolean {
	for (const entry of turn) {
		const text = entryMatchText(entry);
		if (text && regex.test(text)) return true;
	}
	return false;
}

export function chunkTurns(path: SessionEntry[]): SessionEntry[][] {
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

export function findFirstUserEntry(
	path: SessionEntry[],
): SessionMessageEntry | null {
	for (const entry of path) {
		if (entry.type === "message" && entry.message.role === "user") {
			return entry;
		}
	}
	return null;
}

export function nextId(usedIds: Set<string>): string {
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

export function remapClonedEntry(
	entry: SessionEntry,
	idMap: Map<string, string>,
	divergenceParentId: string,
	onPathIds: Set<string>,
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

	const resolveRef = (id: string): string => {
		const mapped = idMap.get(id);
		if (mapped) return mapped;
		if (onPathIds.has(id)) return id;
		// Pointed at a plucked entry — fall back to the forgetful branch's hang point.
		return divergenceParentId;
	};

	if (clone.type === "compaction" && clone.firstKeptEntryId) {
		clone.firstKeptEntryId = resolveRef(clone.firstKeptEntryId);
	}
	if (clone.type === "branch_summary" && clone.fromId) {
		clone.fromId = resolveRef(clone.fromId);
	}
	if (clone.type === "label" && clone.targetId) {
		clone.targetId = resolveRef(clone.targetId);
	}
	return clone;
}

export function buildConfirmMessage(opts: {
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

export function buildLabelText(opts: {
	skippedCount: number;
	originalTurnCount: number;
	regexStr: string;
	labelTime: string;
}): string {
	return `plucked ${opts.skippedCount}/${opts.originalTurnCount} /${opts.regexStr}/ ${opts.labelTime}`;
}

export type PluckPlan =
	| { ok: false; reason: "no_match" | "no_shared_prefix" }
	| {
			ok: true;
			skippedCount: number;
			originalTurnCount: number;
			keptTurnCount: number;
			rootProtected: boolean;
			labelOnly: boolean;
			divergenceParentId: string;
			toClone: SessionEntry[];
			onPathIds: Set<string>;
	  };

/** Pure plan for a forgetful branch — no SessionManager side effects. */
export function planPluck(path: SessionEntry[], regex: RegExp): PluckPlan {
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
		return { ok: false, reason: "no_match" };
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
	const onPathIds = new Set(keptFlat.slice(0, sharedLen).map((e) => e.id));

	if (!divergenceParentId) {
		return { ok: false, reason: "no_shared_prefix" };
	}

	const keptTurnCount = rootProtected
		? Math.max(0, keptTurns.length - 1)
		: keptTurns.length;

	return {
		ok: true,
		skippedCount,
		originalTurnCount: turns.length,
		keptTurnCount,
		rootProtected,
		labelOnly,
		divergenceParentId,
		toClone,
		onPathIds,
	};
}

/** Build remapped clones for a successful plan (still pure — does not append). */
export function buildClones(
	plan: Extract<PluckPlan, { ok: true }>,
	existingIds: Iterable<string>,
): SessionEntry[] {
	const usedIds = new Set(existingIds);
	const idMap = new Map<string, string>();
	for (const entry of plan.toClone) {
		idMap.set(entry.id, nextId(usedIds));
	}
	return plan.toClone.map((entry) =>
		remapClonedEntry(
			entry,
			idMap,
			plan.divergenceParentId,
			plan.onPathIds,
		),
	);
}

/** Session mutators needed to materialize a forgetful branch. */
export type PluckSessionMutators = {
	getLeafId(): string | null;
	getEntries(): SessionEntry[];
	branch(branchFromId: string): void;
	_appendEntry(entry: SessionEntry): void;
	appendCustomMessageEntry(
		customType: string,
		content: string,
		display: boolean,
	): string;
	appendLabelChange(targetId: string, label: string | undefined): string;
};

export function assertPluckMutators(
	sm: Partial<PluckSessionMutators>,
): asserts sm is PluckSessionMutators {
	const required: (keyof PluckSessionMutators)[] = [
		"getLeafId",
		"getEntries",
		"branch",
		"_appendEntry",
		"appendCustomMessageEntry",
		"appendLabelChange",
	];
	for (const key of required) {
		if (typeof sm[key] !== "function") {
			throw new Error(
				`pluck: sessionManager.${key} is not available (need a live SessionManager, not a readonly stub)`,
			);
		}
	}
}

export type ApplyPluckResult = {
	tipId: string;
	cloneCount: number;
};

/**
 * Materialize the forgetful side-branch and restore the caller's leaf.
 *
 * Always hangs a fresh hidden custom_message tip and labels THAT tip — never an
 * existing trunk message (which made pluck look like a no-op on the current tree).
 */
export function applyForgetfulBranch(opts: {
	sm: PluckSessionMutators;
	plan: Extract<PluckPlan, { ok: true }>;
	originalLeafId: string;
	labelText: string;
}): ApplyPluckResult {
	const { sm, plan, originalLeafId, labelText } = opts;
	assertPluckMutators(sm);

	const beforeCount = sm.getEntries().length;
	const clones = buildClones(
		plan,
		sm.getEntries().map((e) => e.id),
	);

	sm.branch(plan.divergenceParentId);
	for (const entry of clones) {
		sm._appendEntry(entry);
	}

	// Fresh tip under the forgetful leaf (last clone, or divergence when label-only).
	const tipId = sm.appendCustomMessageEntry(
		"pi-pluck",
		labelText,
		false,
	);
	if (tipId === originalLeafId || tipId === plan.divergenceParentId) {
		throw new Error(
			`pluck: tip collided with trunk id ${tipId}; refusing to label shared history`,
		);
	}

	sm.appendLabelChange(tipId, labelText);

	const afterCount = sm.getEntries().length;
	const expectedMin = beforeCount + clones.length + 2; // clones + tip + label entry
	if (afterCount < expectedMin) {
		throw new Error(
			`pluck: session did not grow as expected (before=${beforeCount}, after=${afterCount}, clones=${clones.length})`,
		);
	}
	if (!sm.getEntries().some((e) => e.id === tipId)) {
		throw new Error(`pluck: tip ${tipId} missing after append`);
	}

	sm.branch(originalLeafId);
	if (sm.getLeafId() !== originalLeafId) {
		throw new Error(
			`pluck: failed to restore leaf to ${originalLeafId} (now ${sm.getLeafId()})`,
		);
	}

	return { tipId, cloneCount: clones.length };
}
