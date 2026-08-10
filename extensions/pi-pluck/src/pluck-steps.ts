import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** One turn: user message + following entries until the next user message. */
export type Turn = SessionEntry[];

export type PluckPlan =
	| {
			ok: false;
			reason: "no_match" | "not_useful";
			regexStr: string;
	  }
	| {
			ok: true;
			regexStr: string;
			keptTurns: Turn[];
			skippedCount: number;
			originalTurnCount: number;
			keptTurnCount: number;
			/** True when the first user turn matched and the session head was kept. */
			rootProtected: boolean;
			/** Last shared kept ancestor id — hang the side-branch from here. */
			divergenceParentId: string;
			/** Nothing left to clone after the cut; tip will be label-only. */
			labelOnly: boolean;
	  };

/** Parse/validate the /pluck argument into a case-insensitive RegExp. */
export function validateRegex(regexStr: string): RegExp {
	if (!regexStr) {
		throw new Error("Usage: /pluck <regex> (pattern is required)");
	}
	try {
		return new RegExp(regexStr, "i");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid regex: ${message}`);
	}
}

/** Current branch path, split into turns. Throws if the session has no entries. */
export function splitPathIntoTurns(ctx: ExtensionCommandContext): Turn[] {
	const path = ctx.sessionManager.getBranch();
	if (path.length === 0) {
		throw new Error("pluck: this session has no entries yet.");
	}

	const turns: Turn[] = [];
	let current: SessionEntry[] = [];
	for (const entry of path) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (current.length > 0) turns.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

/** Rich forgetful rewrite plan (keep/omit, hang-point, stats, root-head flag). */
export function planForgetfulRewrite(
	_turns: Turn[],
	_regex: RegExp,
	_regexStr: string,
): PluckPlan {
	throw new Error("not implemented: planForgetfulRewrite");
}

/**
 * Confirm dialog body: counts, and a root-head warning when the first prompt
 * matched but must stay. Handler owns the actual ctx.ui.confirm call.
 */
export function buildConfirmMessage(
	_plan: Extract<PluckPlan, { ok: true }>,
): string {
	throw new Error("not implemented: buildConfirmMessage");
}

/**
 * Grow the forgetful side-branch from the plan's hang-point.
 * Does not move the current leaf.
 */
export function growForgetfulBranch(
	_ctx: ExtensionCommandContext,
	_plan: Extract<PluckPlan, { ok: true }>,
): string {
	throw new Error("not implemented: growForgetfulBranch");
}

/** Label the forgetful tip using plan stats (X/Y, regex, time). Returns label text. */
export function labelBranch(
	_ctx: ExtensionCommandContext,
	_tipId: string,
	_plan: Extract<PluckPlan, { ok: true }>,
): string {
	throw new Error("not implemented: labelBranch");
}

/**
 * Summary text after a successful pluck (tip exists; user is still on original leaf).
 * Handler owns the ctx.ui.notify call.
 */
export function buildSummaryMessage(
	_plan: Extract<PluckPlan, { ok: true }>,
	_tipId: string,
	_labelText: string,
): string {
	throw new Error("not implemented: buildSummaryMessage");
}
