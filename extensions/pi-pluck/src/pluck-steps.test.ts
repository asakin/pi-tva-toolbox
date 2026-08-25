import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	buildCancelNote,
	buildConfirmMessage,
	buildForgottenTurns,
	buildLabelText,
	buildOverlayNote,
	buildSummaryMessage,
	formatUnpluckOption,
	planForgetfulRewrite,
	splitPathIntoTurns,
	type PluckPlan,
	type Turn,
	validateRegex,
} from "./pluck-steps.ts";
import registerPluck from "./index.ts";
import { PLUCK_CUSTOM_TYPE, listOverlayNotes } from "./notes.ts";

type MsgRole = "user" | "assistant" | "toolResult";

/** Base of the fixture clock; every message gets a distinct ms timestamp. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
let nextTs = T0;

function msg(
	id: string,
	parentId: string | null,
	role: MsgRole,
	content: unknown,
	timestamp: number = nextTs++,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role, content, timestamp },
	} as unknown as SessionEntry;
}

/** u1→a1, u2(match)→a2, u3→a3 — three turns; middle matches /banana/. */
function sampleBranch(): SessionEntry[] {
	const u1 = msg("u1", null, "user", "hello");
	const a1 = msg("a1", "u1", "assistant", [{ type: "text", text: "hi" }]);
	const u2 = msg("u2", "a1", "user", "talk about banana");
	const a2 = msg("a2", "u2", "assistant", [
		{ type: "text", text: "about banana" },
	]);
	const u3 = msg("u3", "a2", "user", "continue");
	const a3 = msg("a3", "u3", "assistant", [
		{ type: "text", text: "continuing" },
	]);
	return [u1, a1, u2, a2, u3, a3];
}

function turnsFromBranch(branch: SessionEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: SessionEntry[] = [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (current.length > 0) turns.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function mockCtx(opts: {
	branch?: SessionEntry[];
	leafId?: string | null;
}): ExtensionCommandContext {
	const branch = opts.branch ?? sampleBranch();
	let leafId: string | null =
		opts.leafId === undefined ? branch[branch.length - 1]!.id : opts.leafId;

	return {
		sessionManager: {
			getLeafId: () => leafId,
			getBranch: () => branch,
			branch: (id: string) => {
				leafId = id;
			},
		},
		ui: {
			notify: () => {},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

function okPlan(
	overrides: Partial<Extract<PluckPlan, { ok: true }>> = {},
): Extract<PluckPlan, { ok: true }> {
	const turns = turnsFromBranch(sampleBranch());
	return {
		ok: true,
		regexStr: "banana",
		keptTurns: [turns[0]!, turns[2]!],
		skippedCount: 1,
		originalTurnCount: 3,
		keptTurnCount: 2,
		rootProtected: false,
		forgottenPreviews: ["talk about banana"],
		...overrides,
	};
}

describe("validateRegex", () => {
	test("rejects empty input", () => {
		assert.throws(() => validateRegex(""), /usage|empty|required/i);
	});

	test("rejects invalid regex syntax", () => {
		assert.throws(() => validateRegex("("), /invalid regex/i);
	});

	test("returns a case-insensitive RegExp for a valid pattern", () => {
		const re = validateRegex("Banana");
		assert.ok(re instanceof RegExp);
		assert.ok(re.flags.includes("i"));
		assert.strictEqual(re.test("banana"), true);
	});
});

describe("splitPathIntoTurns", () => {
	test("splits the current branch into user-led turns", () => {
		const ctx = mockCtx({ branch: sampleBranch() });
		const turns = splitPathIntoTurns(ctx);
		assert.strictEqual(turns.length, 3);
		assert.deepStrictEqual(turns[0]!.map((e) => e.id), ["u1", "a1"]);
		assert.deepStrictEqual(turns[1]!.map((e) => e.id), ["u2", "a2"]);
		assert.deepStrictEqual(turns[2]!.map((e) => e.id), ["u3", "a3"]);
	});

	test("errors when the session has no entries, without a command prefix", () => {
		const ctx = mockCtx({ branch: [], leafId: null });
		assert.throws(() => splitPathIntoTurns(ctx), /^(?!pluck: ).*no entries/i);
	});
});

describe("planForgetfulRewrite", () => {
	test("returns no_match when nothing matches", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /zzz/, "zzz");
		assert.deepStrictEqual(plan, {
			ok: false,
			reason: "no_match",
			regexStr: "zzz",
		});
	});

	test("omits matching turns and keeps the rest", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.skippedCount, 1);
		assert.strictEqual(plan.originalTurnCount, 3);
		assert.strictEqual(plan.keptTurnCount, 2);
		assert.strictEqual(plan.rootProtected, false);
		assert.deepStrictEqual(plan.keptTurns.map((t) => t[0]!.id), ["u1", "u3"]);
		assert.deepStrictEqual(plan.forgottenPreviews, ["talk about banana"]);
	});

	test("keeps the whole session-head turn when it matches; only later matches are forgotten", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello|banana/i, "hello|banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.rootProtected, true);
		assert.strictEqual(plan.skippedCount, 1);
		assert.strictEqual(plan.keptTurns[0]!.some((e) => e.id === "u1"), true);
		assert.strictEqual(plan.keptTurns[0]!.some((e) => e.id === "a1"), true);
		assert.deepStrictEqual(plan.forgottenPreviews, ["talk about banana"]);
	});

	test("refuses when only the session head matches (nothing to forget)", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello/i, "hello");
		assert.deepStrictEqual(plan, {
			ok: false,
			reason: "not_useful",
			regexStr: "hello",
		});
	});

	test("does not match tool results", () => {
		const u = msg("u1", null, "user", "ask");
		const a = msg("a1", "u1", "assistant", [
			{ type: "text", text: "calling" },
			{ type: "toolCall", name: "read", arguments: { path: "x" } },
		]);
		const tr = msg("tr1", "a1", "toolResult", "secret-banana-payload");
		const turns: Turn[] = [[u, a, tr]];
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.deepStrictEqual(plan, {
			ok: false,
			reason: "no_match",
			regexStr: "banana",
		});
	});

	test("rejects patterns that match every turn (accidental catch-all)", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /.+/, ".+");
		assert.deepStrictEqual(plan, {
			ok: false,
			reason: "catches_all",
			regexStr: ".+",
		});
	});

	test("rejects when every user turn matches (preamble-only survivor)", () => {
		const model = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			provider: "test",
			modelId: "test-model",
		} as SessionEntry;
		const u1 = msg("u1", "m1", "user", "hello banana");
		const a1 = msg("a1", "u1", "assistant", [
			{ type: "text", text: "about banana" },
		]);
		const turns = turnsFromBranch([model, u1, a1]);
		// model_change has no matchable text, so skippedCount < turns.length —
		// but every user-led turn matched, so refuse as catch-all.
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.deepStrictEqual(plan, {
			ok: false,
			reason: "catches_all",
			regexStr: "banana",
		});
	});

	test("a compaction entry rides along in its turn and does not block a pluck", () => {
		const u1 = msg("u1", null, "user", "keep");
		const a1 = msg("a1", "u1", "assistant", [{ type: "text", text: "ok" }]);
		const compaction = {
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "banana banana",
			firstKeptEntryId: "u1",
			tokensBefore: 10,
		} as unknown as SessionEntry;
		const u2 = msg("u2", "c1", "user", "banana");
		const a2 = msg("a2", "u2", "assistant", [{ type: "text", text: "r" }]);
		const u3 = msg("u3", "a2", "user", "after");
		const a3 = msg("a3", "u3", "assistant", [{ type: "text", text: "r" }]);
		const turns = turnsFromBranch([u1, a1, compaction, u2, a2, u3, a3]);
		// The compaction summary is not matchable text, so its turn is kept.
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.deepStrictEqual(plan.keptTurns.map((t) => t.map((e) => e.id)), [["u1", "a1", "c1"], ["u3", "a3"]]);
		assert.deepStrictEqual(buildForgottenTurns(turns, plan).map((f) => f.entryId), ["u2"]);
	});

	test("omits a matching tip turn and keeps the earlier turns", () => {
		const u1 = msg("u1", null, "user", "keep");
		const a1 = msg("a1", "u1", "assistant", [{ type: "text", text: "ok" }]);
		const u2 = msg("u2", "a1", "user", "tip has banana");
		const a2 = msg("a2", "u2", "assistant", [
			{ type: "text", text: "tip reply" },
		]);
		const turns = turnsFromBranch([u1, a1, u2, a2]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.skippedCount, 1);
		assert.deepStrictEqual(plan.keptTurns.map((t) => t[0]!.id), ["u1"]);
		assert.ok(plan.keptTurns.flat().length > 0);
	});
});

describe("buildConfirmMessage", () => {
	test("includes remain/forgotten stats, regex, and turn previews", () => {
		const message = buildConfirmMessage(okPlan());
		assert.match(message, /1/);
		assert.match(message, /banana/i);
		assert.match(message, /2|keep/i);
		assert.match(message, /Turns to forget:/i);
		assert.match(message, /talk about banana/);
		assert.match(message, /Nothing is deleted/);
	});

	test("warns when the session head matched and was kept", () => {
		const message = buildConfirmMessage(
			okPlan({
				rootProtected: true,
				skippedCount: 1,
				forgottenPreviews: ["talk about banana"],
				keptTurnCount: 1,
			}),
		);
		assert.match(message, /session head|first user|prompt/i);
		assert.match(message, /kept|Keeping/i);
		assert.match(message, /Turns to forget:/i);
		assert.match(message, /talk about banana/);
		assert.doesNotMatch(message, /first assistant reply/i);
	});

	test("escapes slashes in the displayed pattern", () => {
		const message = buildConfirmMessage(okPlan({ regexStr: "foo/bar" }));
		assert.match(message, /\/foo\\\/bar\/i/);
	});
});

describe("buildLabelText", () => {
	test("formats plucked X/Y and the regex", () => {
		const plan = okPlan({ skippedCount: 1, originalTurnCount: 3 });
		const labelText = buildLabelText(plan, "12:00");
		assert.strictEqual(labelText, "plucked 1/3 /banana/i 12:00");
	});
});

describe("buildSummaryMessage", () => {
	test("mentions the label, the counts, and how to undo; no entry ids", () => {
		const plan = okPlan();
		const labelText = "plucked 1/3 /banana/i 12:00";
		const message = buildSummaryMessage(plan, labelText);
		assert.match(message, /Forgot 1 of 3 turn/);
		assert.match(message, /plucked 1\/3/);
		assert.match(message, /\/unpluck/);
		assert.doesNotMatch(message, /cloned|\/tree|u2/i);
	});
});

describe("buildForgottenTurns / buildOverlayNote", () => {
	test("keys each forgotten turn on its user message's numeric timestamp", () => {
		const branch = sampleBranch();
		const turns = turnsFromBranch(branch);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		const forgotten = buildForgottenTurns(turns, plan);
		const u2 = branch[2]!;
		assert.strictEqual(u2.id, "u2");
		assert.deepStrictEqual(forgotten, [
			{ ts: (u2 as { message: { timestamp: number } }).message.timestamp, entryId: "u2" },
		]);
		assert.strictEqual(typeof forgotten[0]!.ts, "number");
	});

	test("forgets nothing for a rootProtected head — the plan keeps that whole turn", () => {
		const branch = sampleBranch();
		const turns = turnsFromBranch(branch);
		const plan = planForgetfulRewrite(turns, /hello|banana/i, "hello|banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.rootProtected, true);
		const u2 = branch[2]!;
		assert.strictEqual(u2.id, "u2");
		assert.deepStrictEqual(buildForgottenTurns(turns, plan), [
			{
				ts: (u2 as { message: { timestamp: number } }).message.timestamp,
				entryId: "u2",
			},
		]);
	});

	test("forgets several turns in path order, skipping a leading preamble turn", () => {
		const model = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			provider: "test",
			modelId: "test-model",
		} as SessionEntry;
		const u1 = msg("u1", "m1", "user", "keep", T0 + 1000);
		const a1 = msg("a1", "u1", "assistant", [{ type: "text", text: "ok" }], T0 + 1001);
		const u2 = msg("u2", "a1", "user", "banana one", T0 + 2000);
		const a2 = msg("a2", "u2", "assistant", [{ type: "text", text: "r" }], T0 + 2001);
		const u3 = msg("u3", "a2", "user", "keep too", T0 + 3000);
		const a3 = msg("a3", "u3", "assistant", [{ type: "text", text: "r" }], T0 + 3001);
		const u4 = msg("u4", "a3", "user", "banana two", T0 + 4000);
		const a4 = msg("a4", "u4", "assistant", [{ type: "text", text: "r" }], T0 + 4001);
		const turns = turnsFromBranch([model, u1, a1, u2, a2, u3, a3, u4, a4]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.deepStrictEqual(buildForgottenTurns(turns, plan), [
			{ ts: T0 + 2000, entryId: "u2" },
			{ ts: T0 + 4000, entryId: "u4" },
		]);
	});

	test("throws when a user message lacks a numeric timestamp", () => {
		const u1 = msg("u1", null, "user", "keep");
		const a1 = msg("a1", "u1", "assistant", [{ type: "text", text: "ok" }]);
		const u2 = {
			...msg("u2", "a1", "user", "banana"),
			message: { role: "user", content: "banana", timestamp: "not-a-number" },
		} as unknown as SessionEntry;
		const turns = turnsFromBranch([u1, a1, u2]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.throws(() => buildForgottenTurns(turns, plan), /numeric timestamp/);
	});

	test("buildOverlayNote carries regex, label, and the resolved forgotten set", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		const note = buildOverlayNote(turns, plan, "plucked 1/3 /banana/i 12:00");
		assert.strictEqual(note.kind, "overlay");
		assert.strictEqual(note.regexStr, "banana");
		assert.strictEqual(note.labelText, "plucked 1/3 /banana/i 12:00");
		assert.deepStrictEqual(note.forgotten.map((f) => f.entryId), ["u2"]);
	});
});

describe("unpluck helpers", () => {
	test("formatUnpluckOption shows position, label, and turn count", () => {
		const one = formatUnpluckOption(
			{
				kind: "overlay",
				regexStr: "banana",
				labelText: "plucked 1/3 /banana/i 12:00",
				forgotten: [{ ts: T0, entryId: "u2" }],
			},
			1,
		);
		assert.strictEqual(one, "1. plucked 1/3 /banana/i 12:00 — 1 turn");
		const two = formatUnpluckOption(
			{
				kind: "overlay",
				regexStr: "x",
				labelText: "plucked 2/5 /x/i 13:00",
				forgotten: [
					{ ts: T0, entryId: "u2" },
					{ ts: T0 + 1, entryId: "u4" },
				],
			},
			2,
		);
		assert.match(two, /^2\. .*— 2 turns$/);
	});

	test("buildCancelNote names exactly the chosen note", () => {
		assert.deepStrictEqual(buildCancelNote("note-1"), {
			kind: "cancel",
			noteIds: ["note-1"],
		});
	});
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** Fake pi over a live in-memory session: appendEntry/setLabel write through to it. */
function handlersOver(sm: SessionManager) {
	const handlers = new Map<string, Handler>();
	registerPluck({
		on: () => {},
		registerCommand: (name: string, spec: { handler: Handler }) => handlers.set(name, spec.handler),
		appendEntry: (customType: string, data: unknown) => sm.appendCustomEntry(customType, data),
		setLabel: (id: string, label: string) => sm.appendLabelChange(id, label),
	} as unknown as ExtensionAPI);
	return handlers;
}

function liveCtx(
	sm: SessionManager,
	opts: { hasUI?: boolean; idle?: boolean; confirm?: boolean } = {},
) {
	const notices: Array<{ text: string; level: string }> = [];
	const ctx = {
		sessionManager: sm,
		hasUI: opts.hasUI ?? true,
		isIdle: () => opts.idle ?? true,
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
			confirm: async () => opts.confirm ?? true,
			select: async (_title: string, options: string[]) => options[0],
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices };
}

function liveSession(): SessionManager {
	const sm = SessionManager.inMemory();
	sm.appendMessage({ role: "user", content: "hello", timestamp: T0 });
	sm.appendMessage({ role: "user", content: "talk about banana", timestamp: T0 + 1 });
	sm.appendMessage({ role: "user", content: "continue", timestamp: T0 + 2 });
	return sm;
}

function pluckNotes(sm: SessionManager) {
	return sm.getBranch().filter((e) => e.type === "custom" && e.customType === PLUCK_CUSTOM_TYPE);
}

describe("/pluck and /unpluck handlers", () => {
	test("pluck appends one labeled overlay note; unpluck appends a cancel note", async () => {
		const sm = liveSession();
		const handlers = handlersOver(sm);
		const { ctx, notices } = liveCtx(sm);

		await handlers.get("pluck")!("banana", ctx);
		const notes = pluckNotes(sm);
		assert.strictEqual(notes.length, 1);
		const note = listOverlayNotes(sm.getBranch())[0]!;
		assert.strictEqual(note.cancelled, false);
		assert.deepStrictEqual(note.note.forgotten.map((f) => f.ts), [T0 + 1]);
		assert.match(sm.getLabel(note.id) ?? "", /^plucked 1\/3 \/banana\/i/);
		assert.match(notices.at(-1)?.text ?? "", /^Forgot 1 of 3 turn\(s\) under "plucked/);

		await handlers.get("unpluck")!("", ctx);
		assert.strictEqual(pluckNotes(sm).length, 2);
		assert.strictEqual(listOverlayNotes(sm.getBranch())[0]!.cancelled, true);
		assert.match(notices.at(-1)?.text ?? "", /^Restored 1 turn from/);
	});

	test("a declined confirm and a bad regex write nothing", async () => {
		const sm = liveSession();
		const handlers = handlersOver(sm);
		const declined = liveCtx(sm, { confirm: false });
		await handlers.get("pluck")!("banana", declined.ctx);
		assert.strictEqual(pluckNotes(sm).length, 0);
		assert.match(declined.notices.at(-1)?.text ?? "", /aborted/);

		const bad = liveCtx(sm);
		await handlers.get("pluck")!("(", bad.ctx);
		assert.strictEqual(pluckNotes(sm).length, 0);
		assert.match(bad.notices.at(-1)?.text ?? "", /^pluck: invalid regex/);
	});

	test("both commands refuse while the agent is streaming", async () => {
		const sm = liveSession();
		const handlers = handlersOver(sm);
		const { ctx, notices } = liveCtx(sm, { idle: false });
		await handlers.get("pluck")!("banana", ctx);
		await handlers.get("unpluck")!("", ctx);
		assert.strictEqual(pluckNotes(sm).length, 0);
		assert.deepStrictEqual(
			notices.map((n) => n.text),
			["pluck: wait for the agent to finish its turn.", "unpluck: wait for the agent to finish its turn."],
		);
	});

	test("without a UI both commands refuse and say so on stderr", async () => {
		const sm = liveSession();
		const handlers = handlersOver(sm);
		const { ctx, notices } = liveCtx(sm, { hasUI: false });
		const original = console.error;
		const lines: string[] = [];
		console.error = (line: string) => lines.push(line);
		try {
			await handlers.get("pluck")!("banana", ctx);
			await handlers.get("unpluck")!("", ctx);
		} finally {
			console.error = original;
		}
		assert.strictEqual(pluckNotes(sm).length, 0);
		assert.strictEqual(notices.length, 2);
		assert.deepStrictEqual(lines, notices.map((n) => n.text));
		assert.match(lines[0] ?? "", /^pluck: needs an interactive session/);
	});
});
