import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildConfirmMessage,
	buildSummaryMessage,
	growForgetfulBranch,
	planForgetfulRewrite,
	splitPathIntoTurns,
	validateRegex,
} from "./src/pluck-steps.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pluck", {
		description:
			"Create a labeled forgetful side-branch omitting turns that match a regex "
			+ "(stays on current trunk; jump via /tree to the [plucked …] label on the branch root)",

		// TUI talk and every ending return live here. Steps only compute / mutate.
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const regexStr = args.trim();

			let regex: RegExp;
			try {
				regex = validateRegex(regexStr);
			} catch (error) {
				ctx.ui.notify(
					`pluck: invalid regex /${regexStr}/i: ${errorMessage(error)}`,
					"error",
				);
				return;
			}

			let turns;
			try {
				turns = splitPathIntoTurns(ctx);
			} catch (error) {
				ctx.ui.notify(`pluck: ${errorMessage(error)}`, "error");
				return;
			}

			// Decide what to keep, what to forget, and where the side-branch starts.
			const plan = planForgetfulRewrite(turns, regex, regexStr);

			if (!plan.ok) {
				if (plan.reason === "no_match") {
					ctx.ui.notify(
						`No turns matched regex /${regexStr}/i. Nothing to pluck.`,
						"info",
					);
				} else if (plan.reason === "catches_all") {
					ctx.ui.notify(
						`pluck: /${regexStr}/i matches every turn on this path — refine the pattern so something remains.`,
						"error",
					);
				} else {
					ctx.ui.notify(
						"pluck: nowhere useful to grow a forgetful branch.",
						"error",
					);
				}
				return;
			}

			// Show counts (and warn if the first prompt matched but must stay).
			const confirmed = await ctx.ui.confirm(
				"Create forgetful branch?",
				buildConfirmMessage(plan),
			);
			if (!confirmed) {
				ctx.ui.notify("pluck: aborted.", "info");
				return;
			}

			// Build the labeled forgetful side-branch; leave the user on the trunk.
			let labeledRootId: string;
			let labelText: string;
			let clonedCount: number;
			let tipId: string;
			try {
				({ labeledRootId, labelText, clonedCount, tipId } =
					growForgetfulBranch(ctx, plan));
			} catch (error) {
				ctx.ui.notify(`pluck failed: ${errorMessage(error)}`, "error");
				return;
			}

			ctx.ui.notify(
				buildSummaryMessage(
					plan,
					labeledRootId,
					labelText,
					clonedCount,
					tipId,
				),
				"info",
			);
		},
	});
}
