import { describe, expect, test } from "bun:test";
import type {
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
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
} from "../src/pluck-steps.ts";

type MsgRole = "user" | "assistant" | "toolResult";

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
	} as SessionEntry;
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
		labelOnly: false,
		...overrides,
	};
}

describe("validateRegex", () => {
	test("rejects empty input", () => {
		expect(() => validateRegex("")).toThrow(/usage|empty|required/i);
	});

	test("rejects invalid regex syntax", () => {
		expect(() => validateRegex("(")).toThrow(/invalid regex/i);
	});

	test("returns a case-insensitive RegExp for a valid pattern", () => {
		const re = validateRegex("Banana");
		expect(re).toBeInstanceOf(RegExp);
		expect(re.flags).toContain("i");
		expect(re.test("banana")).toBe(true);
	});
});

describe("splitPathIntoTurns", () => {
	test("splits the current branch into user-led turns", () => {
		const ctx = mockCtx({ branch: sampleBranch() });
		const turns = splitPathIntoTurns(ctx);
		expect(turns).toHaveLength(3);
		expect(turns[0]!.map((e) => e.id)).toEqual(["u1", "a1"]);
		expect(turns[1]!.map((e) => e.id)).toEqual(["u2", "a2"]);
		expect(turns[2]!.map((e) => e.id)).toEqual(["u3", "a3"]);
	});

	test("errors when the session has no entries", () => {
		const ctx = mockCtx({ branch: [], leafId: null });
		expect(() => splitPathIntoTurns(ctx)).toThrow(/no entries/i);
	});
});

describe("planForgetfulRewrite", () => {
	test("returns no_match when nothing matches", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /zzz/, "zzz");
		expect(plan).toEqual({
			ok: false,
			reason: "no_match",
			regexStr: "zzz",
		});
	});

	test("omits matching turns and hangs after the last shared kept ancestor", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.skippedCount).toBe(1);
		expect(plan.originalTurnCount).toBe(3);
		expect(plan.keptTurnCount).toBe(2);
		expect(plan.rootProtected).toBe(false);
		expect(plan.divergenceParentId).toBe("a1");
		expect(plan.keptTurns.map((t) => t[0]!.id)).toEqual(["u1", "u3"]);
	});

	test("never drops the session head; flags rootProtected when first turn matches", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello/i, "hello");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.rootProtected).toBe(true);
		expect(plan.keptTurns[0]!.some((e) => e.id === "u1")).toBe(true);
		expect(plan.keptTurns[0]!.some((e) => e.id === "a1")).toBe(false);
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
		expect(plan).toEqual({
			ok: false,
			reason: "no_match",
			regexStr: "banana",
		});
	});
});

describe("buildConfirmMessage", () => {
	test("includes remain/forgotten stats and the regex", () => {
		const message = buildConfirmMessage(okPlan());
		expect(message).toMatch(/1/);
		expect(message).toMatch(/banana/i);
		expect(message).toMatch(/2|keep/i);
	});

	test("warns when the session head matched and was kept", () => {
		const message = buildConfirmMessage(
			okPlan({ rootProtected: true, skippedCount: 1 }),
		);
		expect(message).toMatch(/initial|session head|first user|prompt/i);
		expect(message).toMatch(/never|keep|cannot forget|will keep/i);
	});
});

describe("growForgetfulBranch", () => {
	test("returns a tip id and does not move the current leaf", async () => {
		const { dirname } = await import("node:path");
		const { realpath } = await import("node:fs/promises");
		const piBin = Bun.which("pi");
		if (!piBin) throw new Error("pi binary not found on PATH");
		const { SessionManager } = await import(
			`${dirname(await realpath(piBin))}/core/session-manager.js`
		);

		const sm = SessionManager.inMemory();
		const ts = () => new Date().toISOString();
		const assistant = (text: string) =>
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

		sm.appendMessage({ role: "user", content: "hello", timestamp: ts() });
		assistant("hi");
		sm.appendMessage({
			role: "user",
			content: "talk about banana",
			timestamp: ts(),
		});
		assistant("about banana");
		sm.appendMessage({ role: "user", content: "continue", timestamp: ts() });
		assistant("continuing");

		const originalLeaf = sm.getLeafId();
		expect(originalLeaf).toBeTruthy();

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		const ctx = {
			sessionManager: sm,
			ui: { notify: () => {}, confirm: async () => true },
		} as unknown as ExtensionCommandContext;

		const { tipId, labelText } = growForgetfulBranch(ctx, plan);
		expect(typeof tipId).toBe("string");
		expect(tipId.length).toBeGreaterThan(0);
		expect(sm.getLeafId()).toBe(originalLeaf);
		expect(tipId).not.toBe(originalLeaf);
		expect(tipId).not.toBe(plan.divergenceParentId);
		expect(labelText).toMatch(/plucked 1\/3/);
		expect(labelText).toMatch(/\/banana\//);
		expect(sm.getLabel(tipId)).toBe(labelText);
		expect(sm.getLabel(originalLeaf!)).toBeUndefined();
	});
});

describe("buildLabelText", () => {
	test("formats plucked X/Y and the regex", () => {
		const plan = okPlan({ skippedCount: 1, originalTurnCount: 3 });
		const labelText = buildLabelText(plan, "12:00");
		expect(labelText).toBe("plucked 1/3 /banana/ 12:00");
	});
});

describe("buildSummaryMessage", () => {
	test("mentions the tip and that the user is still on the current branch", () => {
		const plan = okPlan();
		const labelText = "plucked 1/3 /banana/ 12:00";
		const message = buildSummaryMessage(plan, "tip-1", labelText);
		expect(message).toMatch(/tip-1|plucked 1\/3/);
		expect(message).toMatch(/\/tree|current branch|still on/i);
	});
});
