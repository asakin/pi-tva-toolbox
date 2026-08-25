import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
	ExtensionCommandContext,
	SessionEntry,
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
		divergenceParentId: "a1",
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

	test("errors when the session has no entries", () => {
		const ctx = mockCtx({ branch: [], leafId: null });
		assert.throws(() => splitPathIntoTurns(ctx), /no entries/i);
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

	test("omits matching turns and records the last shared kept ancestor", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.skippedCount, 1);
		assert.strictEqual(plan.originalTurnCount, 3);
		assert.strictEqual(plan.keptTurnCount, 2);
		assert.strictEqual(plan.rootProtected, false);
		assert.strictEqual(plan.divergenceParentId, "a1");
		assert.deepStrictEqual(plan.keptTurns.map((t) => t[0]!.id), ["u1", "u3"]);
		assert.deepStrictEqual(plan.forgottenPreviews, ["talk about banana"]);
	});

	test("never drops the session head; flags rootProtected when first turn matches", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello/i, "hello");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.rootProtected, true);
		assert.strictEqual(plan.keptTurns[0]!.some((e) => e.id === "u1"), true);
		assert.strictEqual(plan.keptTurns[0]!.some((e) => e.id === "a1"), false);
		// Preview the forgotten assistant side — not the kept session-head prompt.
		assert.deepStrictEqual(plan.forgottenPreviews, ["hi"]);
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
		assert.doesNotMatch(message, /Create this side-branch/i);
	});

	test("warns when the session head matched and was kept", () => {
		const message = buildConfirmMessage(
			okPlan({
				rootProtected: true,
				skippedCount: 1,
				forgottenPreviews: ["hi"],
				keptTurnCount: 2,
			}),
		);
		assert.match(message, /session head|first user|prompt/i);
		assert.match(message, /kept|Keeping/i);
		assert.match(message, /Turns to forget:/i);
		assert.match(message, /\bhi\b/);
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
	test("mentions the label, the counts, and how to undo — no entry ids", () => {
		const plan = okPlan();
		const labelText = "plucked 1/3 /banana/i 12:00";
		const message = buildSummaryMessage(plan, labelText);
		assert.match(message, /Forgot 1 of 3 turn/);
		assert.match(message, /plucked 1\/3/);
		assert.match(message, /\/unpluck/);
		assert.match(message, /Nothing was cloned/);
		assert.doesNotMatch(message, /trunk|\/tree/i);
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

	test("forgets nothing for a rootProtected head — the plan keeps that turn's prompt", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello/i, "hello");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;
		assert.strictEqual(plan.rootProtected, true);
		assert.deepStrictEqual(buildForgottenTurns(turns, plan), []);
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
	test("formatUnpluckOption shows the label and the turn count", () => {
		const one = formatUnpluckOption({
			kind: "overlay",
			regexStr: "banana",
			labelText: "plucked 1/3 /banana/i 12:00",
			forgotten: [{ ts: T0, entryId: "u2" }],
		});
		assert.strictEqual(one, "plucked 1/3 /banana/i 12:00 — 1 turn");
		const two = formatUnpluckOption({
			kind: "overlay",
			regexStr: "x",
			labelText: "plucked 2/5 /x/i 13:00",
			forgotten: [
				{ ts: T0, entryId: "u2" },
				{ ts: T0 + 1, entryId: "u4" },
			],
		});
		assert.match(two, /— 2 turns$/);
	});

	test("buildCancelNote names exactly the chosen note", () => {
		assert.deepStrictEqual(buildCancelNote("note-1"), {
			kind: "cancel",
			noteIds: ["note-1"],
		});
	});
});
