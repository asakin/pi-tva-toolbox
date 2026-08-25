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

/** `pi.appendEntry` advances the leaf synchronously; verify it is our note before labelling. */
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

// Both commands need a confirm/select dialog and must not run while a turn is streaming.
// ui.notify is a no-op without a UI (print/json), so that case also goes to stderr.
function ready(ctx: ExtensionCommandContext, command: string): boolean {
	if (!ctx.hasUI) {
		const text = `${command}: needs an interactive session (tui or rpc).`;
		ctx.ui.notify(text, "error");
		console.error(text);
		return false;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify(`${command}: wait for the agent to finish its turn.`, "warning");
		return false;
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	registerHooks(pi);

	pi.registerCommand("pluck", {
		description: "Forget the turns matching a regex on the active branch (/unpluck restores)",

		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ready(ctx, "pluck")) return;
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

			const plan = planForgetfulRewrite(turns, regex, regexStr);

			if (!plan.ok) {
				if (plan.reason === "no_match") {
					ctx.ui.notify(
						`No turns matched regex /${regexStr}/i. Nothing to pluck.`,
						"info",
					);
				} else if (plan.reason === "catches_all") {
					ctx.ui.notify(
						`pluck: /${regexStr}/i matches every turn on this branch; refine the pattern so something remains.`,
						"error",
					);
				} else {
					ctx.ui.notify("pluck: nothing useful to forget here.", "error");
				}
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Forget these turns?",
				buildConfirmMessage(plan),
			);
			if (!confirmed) {
				ctx.ui.notify("pluck: aborted.", "info");
				return;
			}

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
		description: "Restore turns forgotten by /pluck on the active branch",

		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ready(ctx, "unpluck")) return;
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

			const options = active.map((item, i) =>
				formatUnpluckOption(item.note, i + 1),
			);
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
