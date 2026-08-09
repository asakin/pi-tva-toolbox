import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	applyForgetfulBranch,
	assertPluckMutators,
	buildConfirmMessage,
	buildLabelText,
	planPluck,
	type PluckSessionMutators,
} from "./src/pluck-core.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pluck", {
		description:
			"Create a labeled forgetful side-branch omitting turns that match a regex (stays on current leaf; jump via /tree to the plucked tip; resume of this file may open on that tip)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const regexStr = args.trim();
			if (!regexStr) {
				ctx.ui.notify("Usage: /pluck <regex>", "error");
				return;
			}

			let regex: RegExp;
			try {
				regex = new RegExp(regexStr, "i");
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Invalid regex: ${message}`, "error");
				return;
			}

			const originalLeafId = ctx.sessionManager.getLeafId();
			if (!originalLeafId) {
				ctx.ui.notify("pluck: this session has no entries yet.", "info");
				return;
			}

			const path = ctx.sessionManager.getBranch();
			const plan = planPluck(path, regex);

			if (!plan.ok) {
				if (plan.reason === "no_match") {
					ctx.ui.notify(
						`No turns matched regex /${regexStr}/. Nothing to pluck.`,
						"info",
					);
				} else {
					ctx.ui.notify(
						"pluck: nowhere to hang the forgetful branch (no shared prefix).",
						"error",
					);
				}
				return;
			}

			const labelTime = new Date().toTimeString().slice(0, 5);
			const labelText = buildLabelText({
				skippedCount: plan.skippedCount,
				originalTurnCount: plan.originalTurnCount,
				regexStr,
				labelTime,
			});

			const confirmed = await ctx.ui.confirm(
				"Create forgetful branch?",
				buildConfirmMessage({
					regexStr,
					skippedCount: plan.skippedCount,
					keptTurnCount: plan.keptTurnCount,
					rootProtected: plan.rootProtected,
					labelOnly: plan.labelOnly,
				}),
			);
			if (!confirmed) {
				ctx.ui.notify("pluck: aborted.", "info");
				return;
			}

			// Mutate through the live SessionManager only (not pi.setLabel), so
			// branch/append/label share one leaf pointer.
			const sm = ctx.sessionManager as unknown as PluckSessionMutators;
			try {
				assertPluckMutators(sm);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(message, "error");
				return;
			}

			try {
				const { tipId, cloneCount } = applyForgetfulBranch({
					sm,
					plan,
					originalLeafId,
					labelText,
				});
				ctx.ui.notify(
					`Created forgetful tip "${labelText}" (tip ${tipId}, ${cloneCount} cloned entries). Still on your current branch — open /tree and select that label to continue forgetfully.`,
					"info",
				);
			} catch (err: unknown) {
				try {
					sm.branch(originalLeafId);
				} catch {
					/* best-effort restore */
				}
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`pluck failed: ${message}`, "error");
			}
		},
	});
}
