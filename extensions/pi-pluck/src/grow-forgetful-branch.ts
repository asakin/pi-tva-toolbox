import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PluckPlan } from "./plan-forgetful-rewrite.ts";

export type GrowForgetfulBranchResult = {
	/** Id of the labeled entry — first user message on the forgetful branch. */
	labeledRootId: string;
	/** Last cloned entry — the tip you continue from. */
	tipId: string;
	/** How many entries were cloned (should match plan.keptTurns.flat().length). */
	clonedCount: number;
	labelText: string;
};

/**
 * Grow a labeled forgetful side-branch from the plan.
 *
 * Clone *every* kept entry as a parallel chain (not only the post-hang suffix).
 * Shared trunk history is duplicated onto the forgetful side so /tree shows a
 * full M−N-turn branch under the [plucked …] label — a tip you can continue from.
 *
 * Chain rule: entry i+1 always parents to the clone of kept[i], so omitted
 * turns leave no holes. The first clone keeps the original first-kept parent
 * (often null → a second root), i.e. a sibling of the original session head.
 *
 * Label the first *user message* on that chain (not a leading model_change /
 * bash / etc. — those are real nodes but useless /tree signposts).
 *
 * After clones: return to the caller's trunk and append a plain `custom`
 * bookkeeping entry so resume does not rebuild onto the forgetful tip
 * (fork-off pattern).
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
	const toClone = plan.keptTurns.flat();
	if (toClone.length === 0) {
		throw new Error("pluck: plan has no kept entries to clone");
	}

	const usedIds = new Set(sm.getEntries().map((entry) => entry.id));
	const idMap = new Map<string, string>();
	for (const entry of toClone) {
		idMap.set(entry.id, nextId(usedIds));
	}

	const clones = toClone.map((entry, index) =>
		remapClonedEntry(entry, index, toClone, idMap),
	);

	for (const entry of clones) {
		sm._appendEntry(entry);
	}

	const labeledRootId = findLabelTargetId(clones);
	const tipId = clones[clones.length - 1]!.id;

	if (
		labeledRootId === originalLeafId ||
		labeledRootId === plan.divergenceParentId
	) {
		throw new Error(
			`pluck: labeled root collided with trunk id ${labeledRootId}`,
		);
	}

	sm.appendLabelChange(labeledRootId, labelText);

	// Trunk bookkeeping so the last persisted line is on the caller's path.
	sm.branch(originalLeafId);
	const bookkeepingId = sm.appendCustomEntry("pi-pluck", {
		kind: "trunk-anchor",
		labeledRootId,
		tipId,
		clonedCount: clones.length,
		labelText,
		divergenceParentId: plan.divergenceParentId,
	});
	if (sm.getLeafId() !== bookkeepingId) {
		throw new Error(
			`pluck: failed to land on trunk bookkeeping (leaf ${sm.getLeafId()})`,
		);
	}

	return {
		labeledRootId,
		tipId,
		clonedCount: clones.length,
		labelText,
	};
}

/** Label text for /tree: plucked X/Y, regex, clock time. */
export function buildLabelText(
	plan: Extract<PluckPlan, { ok: true }>,
	labelTime = new Date().toTimeString().slice(0, 5),
): string {
	return `plucked ${plan.skippedCount}/${plan.originalTurnCount} /${plan.regexStr}/i ${labelTime}`;
}

/** Prefer the first user message on the clone chain; fall back to the first clone. */
function findLabelTargetId(clones: SessionEntry[]): string {
	for (const entry of clones) {
		if (entry.type === "message" && entry.message.role === "user") {
			return entry.id;
		}
	}
	return clones[0]!.id;
}

/**
 * Deep-clone one kept entry onto the forgetful branch with remapped ids.
 * Parents always follow the kept chain so plucked gaps disappear.
 */
function remapClonedEntry(
	entry: SessionEntry,
	index: number,
	toClone: SessionEntry[],
	idMap: Map<string, string>,
): SessionEntry {
	const clone = JSON.parse(JSON.stringify(entry)) as SessionEntry;
	const newId = idMap.get(entry.id);
	if (!newId) throw new Error(`pluck: missing id map for ${entry.id}`);
	clone.id = newId;

	if (index === 0) {
		// Sibling of the original first kept entry (often a second root).
		clone.parentId = entry.parentId;
	} else {
		const prevId = toClone[index - 1]!.id;
		const mappedPrev = idMap.get(prevId);
		if (!mappedPrev) {
			throw new Error(`pluck: missing id map for previous kept ${prevId}`);
		}
		clone.parentId = mappedPrev;
	}

	const resolveRef = (id: string): string => {
		const mapped = idMap.get(id);
		if (mapped) return mapped;
		// Pointed at a plucked or unknown entry — pin to previous kept clone,
		// or the labeled-root clone when this is the first.
		if (index === 0) return newId;
		return idMap.get(toClone[index - 1]!.id) ?? newId;
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
	appendCustomEntry(customType: string, data?: unknown): string;
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
		"appendCustomEntry",
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
