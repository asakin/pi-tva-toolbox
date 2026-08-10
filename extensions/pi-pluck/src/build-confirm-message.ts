import type { PluckPlan } from "./plan-forgetful-rewrite.ts";

/**
 * Confirm-dialog body for /pluck.
 *
 * Copy is meant to be reviewed carefully — keep it plain, factual, and aimed
 * at a yes/no decision. The handler owns ctx.ui.confirm; this only builds text.
 */
export function buildConfirmMessage(
	plan: Extract<PluckPlan, { ok: true }>,
): string {
	const lines: string[] = [];

	lines.push(`Pattern: /${plan.regexStr}/i`);
	lines.push(
		`Will forget ${plan.skippedCount} of ${plan.originalTurnCount} turn(s) on this path.`,
	);

	if (plan.rootProtected) {
		lines.push("");
		lines.push(
			"Warning: the very first user prompt matched the pattern, but it will not be forgotten.",
		);
		lines.push(
			"That prompt is the session head — removing it would change history for every other branch.",
		);
		lines.push(
			"We will keep the initial prompt and forget the first assistant reply (and its tools) from that turn.",
		);
		if (plan.skippedCount > 1) {
			lines.push(
				`We will also forget ${plan.skippedCount - 1} other matching turn(s).`,
			);
		}
	}

	lines.push("");
	if (plan.labelOnly) {
		lines.push(
			"After the cut, nothing is left to keep — the forgetful branch will be label-only.",
		);
	} else if (plan.rootProtected) {
		lines.push(
			`The forgetful branch keeps ${plan.keptTurnCount} turn(s) after that protected prompt.`,
		);
	} else {
		lines.push(
			`The forgetful branch keeps ${plan.keptTurnCount} turn(s).`,
		);
	}

	lines.push("");
	lines.push(
		"You stay on your current trunk. Use /tree later — find the [plucked …] label on the forgetful branch root.",
	);
	lines.push("Create this side-branch?");

	return lines.join("\n");
}
