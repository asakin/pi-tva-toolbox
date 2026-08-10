import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	planForgetfulRewrite,
	type PluckPlan,
} from "./plan-forgetful-rewrite.ts";

// Re-export so the handler and tests can import the public steps from one place.
export type { PluckPlan };
export { planForgetfulRewrite };
/** Labeled side-branch growth (clones + label on first node); stays on the trunk. */
export { growForgetfulBranch, buildLabelText } from "./grow-forgetful-branch.ts";
/** Confirm-dialog body — plain copy for a yes/no decision. */
export { buildConfirmMessage } from "./build-confirm-message.ts";

/** One conversation turn: a user message plus everything until the next user message. */
export type Turn = SessionEntry[];

/**
 * Turn the /pluck argument into a RegExp.
 * Always case-insensitive. Throws on empty input or bad syntax (handler shows the error).
 */
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

/**
 * Read the current branch and split it into turns.
 * Throws if the session is empty (handler shows the error).
 */
export function splitPathIntoTurns(ctx: ExtensionCommandContext): Turn[] {
	const path = ctx.sessionManager.getBranch();
	if (path.length === 0) {
		throw new Error("pluck: this session has no entries yet.");
	}

	const turns: Turn[] = [];
	let current: SessionEntry[] = [];
	for (const entry of path) {
		// Each user message opens a new turn. Anything before the first user
		// (model changes, etc.) stays as its own leading turn.
		if (entry.type === "message" && entry.message.role === "user") {
			if (current.length > 0) turns.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

/**
 * Build the success summary string. The handler notifies with it.
 * Remind the user they are still on the trunk (/tree to jump to the labeled root).
 */
export function buildSummaryMessage(
	plan: Extract<PluckPlan, { ok: true }>,
	labeledRootId: string,
	labelText: string,
	clonedCount?: number,
	tipId?: string,
): string {
	const clonePart =
		clonedCount === undefined
			? ""
			: ` Cloned ${clonedCount} entries (tip ${tipId ?? "?"}).`;
	return (
		`Created forgetful branch labeled "${labelText}" (root ${labeledRootId}).` +
		clonePart +
		` Forgot ${plan.skippedCount} of ${plan.originalTurnCount} turn(s).` +
		` Still on your current trunk — open /tree and select that label; continue from the tip under it.`
	);
}
