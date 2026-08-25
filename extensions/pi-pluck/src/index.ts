import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { invalidate, registerHooks } from "./hooks.ts";
import { listOverlayNotes, PLUCK_CUSTOM_TYPE } from "./notes.ts";
import {
	buildCancelNote,
	buildConfirmMessage,
	buildLabelText,
	buildOverlayNote,
	buildSummaryMessage,
	formatUnpluckOption,
	planForgetfulRewrite,
	splitPathIntoTurns,
	validateRegex,
} from "./pluck-steps.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `pi.appendEntry` is synchronous and advances the leaf, so the leaf right
 * after the call is the note we just wrote. Verify before labelling it.
 */
function appendNoteAndGetId(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	note: unknown,
): string {
	pi.appendEntry(PLUCK_CUSTOM_TYPE, note);
	const noteId = ctx.sessionManager.getLeafId();
	const entry = noteId ? ctx.sessionManager.getEntry(noteId) : undefined;
	if (
		!noteId ||
		!entry ||
		entry.type !== "custom" ||
		entry.customType !== PLUCK_CUSTOM_TYPE
	) {
		throw new Error("note was appended but the leaf is not the new note");
	}
	return noteId;
}

export default function (pi: ExtensionAPI) {
	registerHooks(pi);

	pi.registerCommand("pluck", {
		description:
			"Forget the turns that match a regex: they leave the model's window but stay in "
			+ "the session (one note on the active branch; /unpluck restores)",

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

			// Decide what to keep and what to forget.
			const plan = planForgetfulRewrite(turns, regex, regexStr);

			if (!plan.ok) {
				if (plan.reason === "no_match") {
					ctx.ui.notify(
						`No turns matched regex /${regexStr}/i. Nothing to pluck.`,
						"info",
					);
				} else if (plan.reason === "catches_all") {
					ctx.ui.notify(
						`pluck: /${regexStr}/i matches every turn on this branch — refine the pattern so something remains.`,
						"error",
					);
				} else {
					ctx.ui.notify("pluck: nothing useful to forget here.", "error");
				}
				return;
			}

			// Show counts (and warn if the first prompt matched but must stay).
			const confirmed = await ctx.ui.confirm(
				"Forget these turns?",
				buildConfirmMessage(plan),
			);
			if (!confirmed) {
				ctx.ui.notify("pluck: aborted.", "info");
				return;
			}

			// One note on the active branch; the label on it is the /tree signpost.
			const labelText = buildLabelText(plan);
			try {
				const note = buildOverlayNote(turns, plan, labelText);
				const noteId = appendNoteAndGetId(pi, ctx, note);
				pi.setLabel(noteId, labelText);
				invalidate();
			} catch (error) {
				ctx.ui.notify(`pluck failed: ${errorMessage(error)}`, "error");
				return;
			}

			ctx.ui.notify(buildSummaryMessage(plan, labelText), "info");
		},
	});

	pi.registerCommand("unpluck", {
		description:
			"Restore the turns forgotten by an earlier /pluck on the active branch "
			+ "(appends a cancel note; nothing is deleted)",

		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			let active: ReturnType<typeof listOverlayNotes>;
			try {
				active = listOverlayNotes(ctx.sessionManager.getBranch()).filter(
					(item) => !item.cancelled,
				);
			} catch (error) {
				ctx.ui.notify(`unpluck: ${errorMessage(error)}`, "error");
				return;
			}

			if (active.length === 0) {
				ctx.ui.notify(
					"unpluck: no active pluck on this branch. Nothing to restore.",
					"info",
				);
				return;
			}

			const options = active.map((item) => formatUnpluckOption(item.note));
			const picked = await ctx.ui.select("Restore which pluck?", options);
			if (picked === undefined) {
				ctx.ui.notify("unpluck: aborted.", "info");
				return;
			}
			const index = options.indexOf(picked);
			const target = active[index];
			if (!target) {
				ctx.ui.notify("unpluck: selection did not match a pluck.", "error");
				return;
			}

			try {
				appendNoteAndGetId(pi, ctx, buildCancelNote(target.id));
				invalidate();
			} catch (error) {
				ctx.ui.notify(`unpluck failed: ${errorMessage(error)}`, "error");
				return;
			}

			const n = target.note.forgotten.length;
			ctx.ui.notify(
				`Restored ${n} turn${n === 1 ? "" : "s"} from "${target.note.labelText}". They are back in the model's window.`,
				"info",
			);
		},
	});
}
