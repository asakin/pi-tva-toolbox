import type { PluckPlan } from "./plan-forgetful-rewrite.ts";
import { formatPattern } from "./format-pattern.ts";

const PREVIEW_LIST_MAX = 8;

/** Confirm-dialog body for /pluck; the dialog title already asks the question. */
export function buildConfirmMessage(
	plan: Extract<PluckPlan, { ok: true }>,
): string {
	const lines: string[] = [];

	lines.push(`Pattern: ${formatPattern(plan.regexStr)}`);

	if (plan.rootProtected) {
		lines.push(
			`Matched ${plan.skippedCount} of ${plan.originalTurnCount} turn(s); session head stays.`,
		);
		lines.push("");
		lines.push(
			"Warning: first user prompt matched but the whole head turn is kept.",
		);
		const keptPrompt = headUserPreview(plan);
		if (keptPrompt) {
			lines.push(`Keeping: ${keptPrompt}`);
		}
		lines.push(
			`Forgetting ${plan.skippedCount} later matching turn(s).`,
		);
	} else {
		lines.push(
			`Will forget ${plan.skippedCount} of ${plan.originalTurnCount} turn(s) on the active branch.`,
		);
	}

	if (plan.forgottenPreviews.length > 0) {
		lines.push("");
		lines.push("Turns to forget:");
		const shown = plan.forgottenPreviews.slice(0, PREVIEW_LIST_MAX);
		for (const preview of shown) {
			lines.push(`  - ${preview}`);
		}
		const remaining = plan.forgottenPreviews.length - shown.length;
		if (remaining > 0) {
			lines.push(`  … and ${remaining} more`);
		}
	}

		lines.push("");
	if (plan.rootProtected) {
		lines.push(
			`Keeps ${plan.keptTurnCount} turn(s) after that protected prompt.`,
		);
	} else {
		lines.push(`The model keeps seeing ${plan.keptTurnCount} turn(s).`);
	}

	lines.push("");
	lines.push(
		"Nothing is deleted: one note is appended and its label shows in /tree. /unpluck restores.",
	);

	return lines.join("\n");
}

function headUserPreview(
	plan: Extract<PluckPlan, { ok: true }>,
): string | null {
	const head = plan.keptTurns[0];
	if (!head) return null;
	for (const entry of head) {
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.map((b) => (b?.type === "text" ? b.text : ""))
								.filter((blockText) => blockText.length > 0)
								.join("\n")
						: "";
			const oneLine = text.replace(/\s+/g, " ").trim();
			if (!oneLine) return null;
			return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
		}
	}
	return null;
}
