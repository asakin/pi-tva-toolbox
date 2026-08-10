import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildConfirmMessage,
	buildSummaryMessage,
	growForgetfulBranch,
	labelBranch,
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
			+ "(stays on current leaf; jump via /tree to the plucked tip; "
			+ "resume of this file may open on that branch)",

		// TUI talk and every ending return live here. Steps only compute / mutate.
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const regexStr = args.trim();

			let regex: RegExp;
			try {
				regex = validateRegex(regexStr);
			} catch (error) {
				ctx.ui.notify(
					`pluck: invalid regex /${regexStr}/: ${errorMessage(error)}`,
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
						`No turns matched regex /${regexStr}/. Nothing to pluck.`,
						"info",
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

			// Build the forgetful side-branch; leave the user on their current leaf.
			let newBranchTip: string;
			let labelText: string;
			try {
				newBranchTip = growForgetfulBranch(ctx, plan);
				labelText = labelBranch(ctx, newBranchTip, plan);
			} catch (error) {
				ctx.ui.notify(`pluck failed: ${errorMessage(error)}`, "error");
				return;
			}

			// User is still on the original leaf; they jump via /tree when they want.
			ctx.ui.notify(
				buildSummaryMessage(plan, newBranchTip, labelText),
				"info",
			);
		},
	});
}
