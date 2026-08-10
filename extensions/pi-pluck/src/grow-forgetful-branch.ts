import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PluckPlan } from "./plan-forgetful-rewrite.ts";

export type GrowForgetfulBranchResult = {
	tipId: string;
	labelText: string;
};

/**
 * Grow a labeled forgetful side-branch from the plan's hang-point.
 *
 * - Point the leaf at the shared ancestor, append remapped kept-suffix clones,
 *   hang a fresh hidden tip, and label that tip (never a trunk node).
 * - Always restore the caller's leaf before returning.
 */
export function growForgetfulBranch(
	ctx: ExtensionCommandContext,
	plan: Extract<PluckPlan, { ok: true }>,
): GrowForgetfulBranchResult {
	const sm = ctx.sessionManager as unknown as Partial<PluckSessionMutators>;
	assertMutators(sm);

	const originalLeafId = sm.getLeafId();
	if (!originalLeafId) {
		throw new Error("pluck: this session has no leaf to restore");
	}

	const labelText = buildLabelText(plan);
	const { toClone, onPathIds } = entriesToClone(plan);
	const usedIds = new Set(sm.getEntries().map((entry) => entry.id));
	const idMap = new Map<string, string>();
	for (const entry of toClone) {
		idMap.set(entry.id, nextId(usedIds));
	}
	const clones = toClone.map((entry) =>
		remapClonedEntry(entry, idMap, plan.divergenceParentId, onPathIds),
	);

	sm.branch(plan.divergenceParentId);
	for (const entry of clones) {
		sm._appendEntry(entry);
	}

	// Fresh tip under the forgetful leaf (last clone, or divergence when label-only).
	const tipId = sm.appendCustomMessageEntry("pi-pluck", labelText, false);
	if (tipId === originalLeafId || tipId === plan.divergenceParentId) {
		throw new Error(
			`pluck: tip collided with trunk id ${tipId}; refusing to grow on shared history`,
		);
	}
	sm.appendLabelChange(tipId, labelText);

	sm.branch(originalLeafId);
	if (sm.getLeafId() !== originalLeafId) {
		throw new Error(
			`pluck: failed to restore leaf to ${originalLeafId} (now ${sm.getLeafId()})`,
		);
	}

	return { tipId, labelText };
}

/** Label text for /tree: plucked X/Y, regex, clock time. */
export function buildLabelText(
	plan: Extract<PluckPlan, { ok: true }>,
	labelTime = new Date().toTimeString().slice(0, 5),
): string {
	return `plucked ${plan.skippedCount}/${plan.originalTurnCount} /${plan.regexStr}/i ${labelTime}`;
}

/** Entries in keptTurns that sit after the hang-point — these get cloned. */
function entriesToClone(
	plan: Extract<PluckPlan, { ok: true }>,
): { toClone: SessionEntry[]; onPathIds: Set<string> } {
	const keptFlat = plan.keptTurns.flat();
	const hangIdx = keptFlat.findIndex(
		(entry) => entry.id === plan.divergenceParentId,
	);
	if (hangIdx < 0) {
		throw new Error(
			`pluck: hang-point ${plan.divergenceParentId} missing from kept path`,
		);
	}
	return {
		toClone: keptFlat.slice(hangIdx + 1),
		onPathIds: new Set(keptFlat.slice(0, hangIdx + 1).map((e) => e.id)),
	};
}

/**
 * Deep-clone one entry onto the forgetful branch with remapped ids.
 * Parents/refs that pointed at plucked entries fall back to the hang-point.
 */
function remapClonedEntry(
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
		// Pointed at a plucked entry — hang from the shared cut instead.
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

/**
 * Methods we actually call on the live SessionManager.
 *
 * On ExtensionCommandContext, sessionManager is typed read-only (no writes).
 * At runtime it is still a full SessionManager — these are the mutating
 * methods we cast to. "_appendEntry" is private upstream; we need it because
 * public append* helpers always mint new ids, and clones must keep our remapped ones.
 */
type PluckSessionMutators = {
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

/** Fail fast if ctx handed us a readonly stub instead of a real SessionManager. */
function assertMutators(
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
				`pluck: sessionManager.${key} is not available (need a live SessionManager)`,
			);
		}
	}
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
