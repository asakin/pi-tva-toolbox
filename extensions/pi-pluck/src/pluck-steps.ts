import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	planForgetfulRewrite,
	type PluckPlan,
} from "./plan-forgetful-rewrite.ts";
import type { CancelNote, ForgottenTurn, OverlayNote } from "./notes.ts";
import { formatPattern } from "./format-pattern.ts";

// Re-export so the handler and tests can import the public steps from one place.
export type { PluckPlan };
export { planForgetfulRewrite };
/** Confirm-dialog body — plain copy for a yes/no decision. */
export { buildConfirmMessage } from "./build-confirm-message.ts";
/** Display /pattern/i with escaped slashes. */
export { formatPattern } from "./format-pattern.ts";

/** One conversation turn: a user message plus everything until the next user message. */
export type Turn = SessionEntry[];

type OkPlan = Extract<PluckPlan, { ok: true }>;

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

/** Label text for /tree: plucked X/Y, regex, clock time. */
export function buildLabelText(
	plan: OkPlan,
	labelTime = new Date().toTimeString().slice(0, 5),
): string {
	return `plucked ${plan.skippedCount}/${plan.originalTurnCount} ${formatPattern(plan.regexStr)} ${labelTime}`;
}

/**
 * The turns the plan forgets, keyed the way `shape()` matches them: the user
 * message's millisecond timestamp (entryId is for listings only).
 *
 * A turn is forgotten when it is not in `plan.keptTurns` (compared by first
 * entry id). For a rootProtected head the plan keeps the prompt as a sliced
 * turn, so it is present in keptTurns and nothing is forgotten for it — the
 * overlay cannot drop half a turn, and mirroring the plan keeps the head safe.
 */
export function buildForgottenTurns(
	turns: Turn[],
	plan: OkPlan,
): ForgottenTurn[] {
	const keptFirstIds = new Set<string>();
	for (const turn of plan.keptTurns) {
		if (turn[0]) keptFirstIds.add(turn[0].id);
	}
	const forgotten: ForgottenTurn[] = [];
	for (const turn of turns) {
		const first = turn[0];
		if (!first || keptFirstIds.has(first.id)) continue;
		const user = turn.find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		if (!user || user.type !== "message") continue;
		const ts = user.message.timestamp;
		if (typeof ts !== "number") {
			throw new Error(
				`pluck: user message ${user.id} has no numeric timestamp; cannot key the turn`,
			);
		}
		forgotten.push({ ts, entryId: user.id });
	}
	return forgotten;
}

/** The overlay note /pluck appends: what the user confirmed, resolved at pluck time. */
export function buildOverlayNote(
	turns: Turn[],
	plan: OkPlan,
	labelText: string,
): OverlayNote {
	return {
		kind: "overlay",
		regexStr: plan.regexStr,
		labelText,
		forgotten: buildForgottenTurns(turns, plan),
	};
}

/**
 * Build the success summary string. The handler notifies with it.
 * Keep it human: label + counts + how to undo — no raw entry ids.
 */
export function buildSummaryMessage(plan: OkPlan, labelText: string): string {
	return (
		`Forgot ${plan.skippedCount} of ${plan.originalTurnCount} turn(s) under label "${labelText}".` +
		` Nothing was cloned; the turns stay in the session file and /unpluck restores them.`
	);
}

/** One selectable row for /unpluck: position (labels can repeat), label, turn count. */
export function formatUnpluckOption(note: OverlayNote, position: number): string {
	const n = note.forgotten.length;
	return `${position}. ${note.labelText} — ${n} turn${n === 1 ? "" : "s"}`;
}

/** The cancel note /unpluck appends for one overlay note. */
export function buildCancelNote(noteId: string): CancelNote {
	return { kind: "cancel", noteIds: [noteId] };
}
