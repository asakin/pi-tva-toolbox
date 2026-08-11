import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildConfirmMessage,
	buildLabelText,
	buildSummaryMessage,
	growForgetfulBranch,
	planForgetfulRewrite,
	splitPathIntoTurns,
	type PluckPlan,
	type Turn,
	validateRegex,
} from "./pluck-steps.ts";

type MsgRole = "user" | "assistant" | "toolResult";
type LiveSession = ReturnType<typeof SessionManager.inMemory>;

function msg(
	id: string,
	parentId: string | null,
	role: MsgRole,
	content: unknown,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: "2026-01-01T00:00:00.000Z" },
	} as unknown as SessionEntry;
}

/** Role of a message entry, or undefined when the entry is not a message. */
function roleOf(sm: LiveSession, id: string): string | undefined {
	const entry = sm.getEntry(id) as SessionEntry | undefined;
	return entry?.type === "message" ? entry.message.role : undefined;
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

function makeSm(): LiveSession {
	return SessionManager.inMemory();
}

function appendAssistant(sm: LiveSession, text: string): void {
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function appendUser(sm: LiveSession, content: string): void {
	sm.appendMessage({
		role: "user",
		content,
		timestamp: Date.now(),
	});
}

/** Seed alternating user/assistant turns from content pairs. */
function seedTurns(
	sm: LiveSession,
	turns: Array<{ user: string; assistant: string }>,
): void {
	for (const turn of turns) {
		appendUser(sm, turn.user);
		appendAssistant(sm, turn.assistant);
	}
}

function growCtx(sm: LiveSession): ExtensionCommandContext {
	return {
		sessionManager: sm,
		ui: { notify: () => {}, confirm: async () => true },
	} as unknown as ExtensionCommandContext;
}

function countForgetfulUserTurns(
	sm: LiveSession,
	labeledRootId: string,
): number {
	const byParent = new Map<string, SessionEntry[]>();
	for (const entry of sm.getEntries() as SessionEntry[]) {
		if (!entry.parentId) continue;
		const list = byParent.get(entry.parentId) ?? [];
		list.push(entry);
		byParent.set(entry.parentId, list);
	}

	let count = 0;
	const stack = [labeledRootId];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const entry = sm.getEntry(id) as SessionEntry | undefined;
		if (!entry) continue;
		if (entry.type === "message" && entry.message.role === "user") {
			count++;
		}
		for (const child of byParent.get(id) ?? []) {
			if (child.type === "label") continue;
			stack.push(child.id);
		}
	}
	return count;
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

	test("omits matching turns and hangs after the last shared kept ancestor", () => {
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
		// Grow still clones the kept chain even when the hang sits at the tip.
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

describe("growForgetfulBranch", () => {
	test("labels the forgetful-branch root and anchors the leaf on the trunk", () => {
		const sm = makeSm();
		seedTurns(sm, [
			{ user: "hello", assistant: "hi" },
			{ user: "talk about banana", assistant: "about banana" },
			{ user: "continue", assistant: "continuing" },
		]);

		const originalLeaf = sm.getLeafId();
		assert.ok(originalLeaf);

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		const { labeledRootId, labelText, clonedCount, tipId } =
			growForgetfulBranch(growCtx(sm), plan);
		assert.strictEqual(typeof labeledRootId, "string");
		assert.notStrictEqual(labeledRootId, originalLeaf);
		assert.match(labelText, /plucked 1\/3/);
		assert.match(labelText, /\/banana\/i/);
		assert.strictEqual(clonedCount, plan.keptTurns.flat().length);
		assert.ok(tipId);

		assert.strictEqual(sm.getLabel(labeledRootId), labelText);
		assert.strictEqual(sm.getLabel(originalLeaf!), undefined);
		assert.strictEqual(sm.getEntry(labeledRootId)?.type, "message");
		assert.strictEqual(roleOf(sm, labeledRootId), "user");

		assert.strictEqual(
			sm.getEntries().some(
				(e: SessionEntry) =>
					e.type === "custom_message" && e.customType === "pi-pluck",
			),
			false,
		);

		const leafId = sm.getLeafId();
		assert.ok(leafId);
		const leaf = sm.getEntry(leafId!);
		assert.strictEqual(leaf?.type, "custom");
		assert.strictEqual(leaf?.customType, "pi-pluck");
		assert.strictEqual(leaf?.parentId, originalLeaf);
	});

	test("restores trunk leaf if grow fails after clones", () => {
		const sm = makeSm();
		seedTurns(sm, [
			{ user: "hello", assistant: "hi" },
			{ user: "talk about banana", assistant: "about banana" },
			{ user: "continue", assistant: "continuing" },
		]);

		const originalLeaf = sm.getLeafId();
		assert.ok(originalLeaf);

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		sm.appendLabelChange = () => {
			throw new Error("boom: label failed");
		};

		assert.throws(
			() => growForgetfulBranch(growCtx(sm), plan),
			/boom: label failed/,
		);
		assert.strictEqual(sm.getLeafId(), originalLeaf);
	});

	test("forget N of M turns → forgetful branch has M−N turns (not a length-1 stub)", () => {
		// Repro: after /pluck commit (56/130), /tree showed a labeled side-branch
		// with only the first kept turn + aborted assistant — nowhere to continue.
		const sm = makeSm();
		const totalTurns = 10;
		const forgetAt = 2;
		for (let i = 0; i < totalTurns; i++) {
			const content =
				i === forgetAt ? `turn ${i} BANANA please forget` : `turn ${i} keep me`;
			appendUser(sm, content);
			appendAssistant(sm, `reply ${i}`);
		}

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		assert.strictEqual(turns.length, totalTurns);

		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		assert.strictEqual(plan.skippedCount, 1);
		assert.strictEqual(plan.originalTurnCount, totalTurns);
		const expectedKept = totalTurns - plan.skippedCount;
		assert.strictEqual(plan.keptTurns.length, expectedKept);

		const { labeledRootId, clonedCount } = growForgetfulBranch(
			growCtx(sm),
			plan,
		);
		assert.strictEqual(clonedCount, plan.keptTurns.flat().length);
		assert.strictEqual(roleOf(sm, labeledRootId), "user");
		assert.strictEqual(
			countForgetfulUserTurns(sm, labeledRootId),
			expectedKept,
		);
	});

	test("labels the first user message, not a leading model_change", () => {
		const sm = makeSm();
		sm.appendModelChange("google", "gemini-pro-latest");
		seedTurns(sm, [
			{ user: "keep turn 0", assistant: "reply 0" },
			{ user: "BANANA forget this", assistant: "forgotten" },
			{ user: "keep tip", assistant: "reply tip" },
		]);

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		const { labeledRootId, clonedCount, tipId } = growForgetfulBranch(
			growCtx(sm),
			plan,
		);
		assert.strictEqual(clonedCount, plan.keptTurns.flat().length);
		assert.ok(clonedCount > 2);
		const labeled = sm.getEntry(labeledRootId) as SessionEntry;
		assert.strictEqual(labeled.type, "message");
		assert.strictEqual(labeled.message.role, "user");
		const label = sm.getLabel(labeledRootId);
		assert.ok(label);
		assert.match(label, /plucked/);
		assert.notStrictEqual(sm.getEntry(tipId)?.type, "label");
	});

	test("when the branch tip matches the regex, forgetful branch still has the kept turns", () => {
		const sm = makeSm();
		seedTurns(sm, [
			{ user: "keep turn 0", assistant: "reply 0" },
			{ user: "keep turn 1", assistant: "reply 1" },
			{
				user: "tip mentions BANANA right before /pluck",
				assistant: "tip assistant also says banana",
			},
		]);

		const tipLeafId = sm.getLeafId();
		assert.ok(tipLeafId);

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		assert.strictEqual(turns.length, 3);

		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.strictEqual(plan.ok, true);
		if (!plan.ok) return;

		assert.strictEqual(plan.skippedCount, 1);
		assert.strictEqual(plan.keptTurns.length, 2);
		const keptFlat = plan.keptTurns.flat();
		assert.strictEqual(keptFlat.some((e) => e.id === tipLeafId), false);

		const { labeledRootId, labelText, clonedCount, tipId } =
			growForgetfulBranch(growCtx(sm), plan);
		assert.strictEqual(sm.getLabel(labeledRootId), labelText);
		assert.strictEqual(clonedCount, keptFlat.length);
		assert.strictEqual(roleOf(sm, labeledRootId), "user");
		assert.strictEqual(countForgetfulUserTurns(sm, labeledRootId), 2);

		const forgetfulTip = sm.getEntry(tipId) as SessionEntry;
		assert.strictEqual(forgetfulTip.type, "message");
		assert.notStrictEqual(tipId, tipLeafId);
		assert.strictEqual(sm.getBranch(tipId).length, keptFlat.length);
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
	test("mentions the label and that the user is still on the trunk", () => {
		const plan = okPlan();
		const labelText = "plucked 1/3 /banana/i 12:00";
		const message = buildSummaryMessage(
			plan,
			"root-1",
			labelText,
			12,
			"tip-1",
		);
		assert.match(message, /plucked 1\/3/);
		assert.match(message, /Cloned 12/);
		assert.doesNotMatch(message, /root-1/);
		assert.doesNotMatch(message, /tip-1/);
		assert.match(message, /\/tree|trunk|still on/i);
	});
});
