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
		forgottenPreviews: ["talk about banana"],
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
		expect(plan.forgottenPreviews).toEqual(["talk about banana"]);
	});

	test("never drops the session head; flags rootProtected when first turn matches", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /hello/i, "hello");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.rootProtected).toBe(true);
		expect(plan.keptTurns[0]!.some((e) => e.id === "u1")).toBe(true);
		expect(plan.keptTurns[0]!.some((e) => e.id === "a1")).toBe(false);
		// Preview the forgotten assistant side — not the kept session-head prompt.
		expect(plan.forgottenPreviews).toEqual(["hi"]);
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

	test("rejects patterns that match every turn (accidental catch-all)", () => {
		const turns = turnsFromBranch(sampleBranch());
		const plan = planForgetfulRewrite(turns, /.+/, ".+");
		expect(plan).toEqual({
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
		expect(plan).toEqual({
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
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.skippedCount).toBe(1);
		expect(plan.keptTurns.map((t) => t[0]!.id)).toEqual(["u1"]);
		// Grow still clones the kept chain even when the hang sits at the tip.
		expect(plan.keptTurns.flat().length).toBeGreaterThan(0);
	});
});

describe("buildConfirmMessage", () => {
	test("includes remain/forgotten stats, regex, and turn previews", () => {
		const message = buildConfirmMessage(okPlan());
		expect(message).toMatch(/1/);
		expect(message).toMatch(/banana/i);
		expect(message).toMatch(/2|keep/i);
		expect(message).toMatch(/Turns to forget:/i);
		expect(message).toMatch(/talk about banana/);
		expect(message).not.toMatch(/Create this side-branch/i);
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
		expect(message).toMatch(/session head|first user|prompt/i);
		expect(message).toMatch(/kept|Keeping/i);
		expect(message).toMatch(/Turns to forget:/i);
		expect(message).toMatch(/\bhi\b/);
	});

	test("escapes slashes in the displayed pattern", () => {
		const message = buildConfirmMessage(okPlan({ regexStr: "foo/bar" }));
		expect(message).toMatch(/\/foo\\\/bar\/i/);
	});
});

describe("growForgetfulBranch", () => {
	test("labels the forgetful-branch root and anchors the leaf on the trunk", async () => {
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

		const { labeledRootId, labelText, clonedCount, tipId } =
			growForgetfulBranch(ctx, plan);
		expect(typeof labeledRootId).toBe("string");
		expect(labeledRootId).not.toBe(originalLeaf);
		expect(labelText).toMatch(/plucked 1\/3/);
		expect(labelText).toMatch(/\/banana\/i/);
		expect(clonedCount).toBe(plan.keptTurns.flat().length);
		expect(tipId).toBeTruthy();

		// Label sits on the first user message of the forgetful branch.
		expect(sm.getLabel(labeledRootId)).toBe(labelText);
		expect(sm.getLabel(originalLeaf!)).toBeUndefined();
		expect(sm.getEntry(labeledRootId)?.type).toBe("message");
		expect(sm.getEntry(labeledRootId)?.message.role).toBe("user");


		// No synthetic tip message — bookmarks are labels on real turns.
		expect(
			sm.getEntries().some(
				(e: SessionEntry) =>
					e.type === "custom_message" && e.customType === "pi-pluck",
			),
		).toBe(false);

		// Trunk bookkeeping: leaf is a plain custom child of the original leaf
		// so resume does not rebuild onto the forgetful tip (fork-off pattern).
		const leafId = sm.getLeafId();
		expect(leafId).toBeTruthy();
		const leaf = sm.getEntry(leafId!);
		expect(leaf?.type).toBe("custom");
		expect(leaf?.customType).toBe("pi-pluck");
		expect(leaf?.parentId).toBe(originalLeaf);
	});

	test("restores trunk leaf if grow fails after clones", async () => {
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

		sm.appendLabelChange = () => {
			throw new Error("boom: label failed");
		};

		const ctx = {
			sessionManager: sm,
			ui: { notify: () => {}, confirm: async () => true },
		} as unknown as ExtensionCommandContext;

		expect(() => growForgetfulBranch(ctx, plan)).toThrow(/boom: label failed/);
		expect(sm.getLeafId()).toBe(originalLeaf);
	});

	test("forget N of M turns → forgetful branch has M−N turns (not a length-1 stub)", async () => {
		// Repro: after /pluck commit (56/130), /tree showed a labeled side-branch
		// with only the first kept turn + aborted assistant — nowhere to continue.
		// Product rule: if we forget 1 of 10, the new branch must carry all 9 kept
		// turns under the labeled root (a tip you can actually resume from).
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

		const totalTurns = 10;
		const forgetAt = 2; // early-ish omit so a long kept suffix should exist
		for (let i = 0; i < totalTurns; i++) {
			const content =
				i === forgetAt ? `turn ${i} BANANA please forget` : `turn ${i} keep me`;
			sm.appendMessage({ role: "user", content, timestamp: ts() });
			assistant(`reply ${i}`);
		}

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		expect(turns.length).toBe(totalTurns);

		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		expect(plan.skippedCount).toBe(1);
		expect(plan.originalTurnCount).toBe(totalTurns);
		const expectedKept = totalTurns - plan.skippedCount;
		expect(plan.keptTurns.length).toBe(expectedKept);

		const ctx = {
			sessionManager: sm,
			ui: { notify: () => {}, confirm: async () => true },
		} as unknown as ExtensionCommandContext;

		const { labeledRootId, clonedCount } = growForgetfulBranch(ctx, plan);
		expect(clonedCount).toBe(plan.keptTurns.flat().length);
		expect(sm.getEntry(labeledRootId)?.message.role).toBe("user");

		// User turns on the forgetful side-branch: labeled root + every descendant
		// user message. This is what /tree shows under the [plucked …] marker —
		// not "shared trunk + tiny stub".
		const byParent = new Map<string, SessionEntry[]>();
		for (const entry of sm.getEntries() as SessionEntry[]) {
			if (!entry.parentId) continue;
			const list = byParent.get(entry.parentId) ?? [];
			list.push(entry);
			byParent.set(entry.parentId, list);
		}

		const forgetfulUserTurns: SessionEntry[] = [];
		const stack = [labeledRootId];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = sm.getEntry(id) as SessionEntry | undefined;
			if (!entry) continue;
			if (entry.type === "message" && entry.message.role === "user") {
				forgetfulUserTurns.push(entry);
			}
			for (const child of byParent.get(id) ?? []) {
				// Label entries hang under the tip; skip non-conversation noise for count.
				if (child.type === "label") continue;
				stack.push(child.id);
			}
		}

		expect(forgetfulUserTurns.length).toBe(expectedKept);
	});

	test("labels the first user message, not a leading model_change", async () => {
		// Field: [plucked …] [model: gemini-pro-latest] with only bash under it.
		// Leading model_change must not be the /tree signpost.
		const { dirname } = await import("node:path");
		const { realpath } = await import("node:fs/promises");
		const piBin = Bun.which("pi");
		if (!piBin) throw new Error("pi binary not found on PATH");
		const { SessionManager } = await import(
			`${dirname(await realpath(piBin))}/core/session-manager.js`
		);

		const sm = SessionManager.inMemory();
		const ts = () => new Date().toISOString();
		sm.appendModelChange("google", "gemini-pro-latest");
		sm.appendMessage({ role: "user", content: "keep turn 0", timestamp: ts() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply 0" }],
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
		sm.appendMessage({
			role: "user",
			content: "BANANA forget this",
			timestamp: ts(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "forgotten" }],
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
		sm.appendMessage({ role: "user", content: "keep tip", timestamp: ts() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply tip" }],
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

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		const ctx = {
			sessionManager: sm,
			ui: { notify: () => {}, confirm: async () => true },
		} as unknown as ExtensionCommandContext;

		const { labeledRootId, clonedCount, tipId } = growForgetfulBranch(
			ctx,
			plan,
		);
		expect(clonedCount).toBe(plan.keptTurns.flat().length);
		expect(clonedCount).toBeGreaterThan(2);
		const labeled = sm.getEntry(labeledRootId) as SessionEntry;
		expect(labeled.type).toBe("message");
		expect(labeled.message.role).toBe("user");
		expect(sm.getLabel(labeledRootId)).toMatch(/plucked/);
		// Tip is the last kept clone, not the label entry.
		expect(sm.getEntry(tipId)?.type).not.toBe("label");
	});

	test("when the branch tip matches the regex, forgetful branch still has the kept turns", async () => {
		// Theory: /pluck <regex> where the tip message (the turn right before the
		// command) matches → forgetful side shows nothing. Tip must be forgettable
		// without wiping the branch you continue on.
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

		sm.appendMessage({ role: "user", content: "keep turn 0", timestamp: ts() });
		assistant("reply 0");
		sm.appendMessage({ role: "user", content: "keep turn 1", timestamp: ts() });
		assistant("reply 1");
		sm.appendMessage({
			role: "user",
			content: "tip mentions BANANA right before /pluck",
			timestamp: ts(),
		});
		assistant("tip assistant also says banana");

		const tipLeafId = sm.getLeafId();
		expect(tipLeafId).toBeTruthy();

		const turns = turnsFromBranch(sm.getBranch() as SessionEntry[]);
		expect(turns.length).toBe(3);

		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		// Tip turn is the one that matched and must be omitted from the plan.
		expect(plan.skippedCount).toBe(1);
		expect(plan.keptTurns.length).toBe(2);
		const keptFlat = plan.keptTurns.flat();
		expect(keptFlat.some((e) => e.id === tipLeafId)).toBe(false);

		const ctx = {
			sessionManager: sm,
			ui: { notify: () => {}, confirm: async () => true },
		} as unknown as ExtensionCommandContext;

		const { labeledRootId, labelText, clonedCount, tipId } =
			growForgetfulBranch(ctx, plan);
		expect(sm.getLabel(labeledRootId)).toBe(labelText);
		expect(clonedCount).toBe(keptFlat.length);
		expect(sm.getEntry(labeledRootId)?.message.role).toBe("user");

		const byParent = new Map<string, SessionEntry[]>();
		for (const entry of sm.getEntries() as SessionEntry[]) {
			if (!entry.parentId) continue;
			const list = byParent.get(entry.parentId) ?? [];
			list.push(entry);
			byParent.set(entry.parentId, list);
		}

		const forgetfulUserTurns: SessionEntry[] = [];
		const stack = [labeledRootId];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = sm.getEntry(id) as SessionEntry | undefined;
			if (!entry) continue;
			if (entry.type === "message" && entry.message.role === "user") {
				forgetfulUserTurns.push(entry);
			}
			for (const child of byParent.get(id) ?? []) {
				if (child.type === "label") continue;
				stack.push(child.id);
			}
		}

		expect(forgetfulUserTurns.length).toBe(2);
		for (const entry of forgetfulUserTurns) {
			const text =
				typeof entry.message.content === "string"
					? entry.message.content
					: "";
			expect(text).not.toMatch(/banana/i);
		}

		const forgetfulTip = sm.getEntry(tipId) as SessionEntry;
		expect(forgetfulTip.type).toBe("message");
		expect(tipId).not.toBe(tipLeafId);
		expect(sm.getBranch(tipId).length).toBe(keptFlat.length);
	});
});

describe("buildLabelText", () => {
	test("formats plucked X/Y and the regex", () => {
		const plan = okPlan({ skippedCount: 1, originalTurnCount: 3 });
		const labelText = buildLabelText(plan, "12:00");
		expect(labelText).toBe("plucked 1/3 /banana/i 12:00");
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
		expect(message).toMatch(/plucked 1\/3/);
		expect(message).toMatch(/Cloned 12/);
		expect(message).not.toMatch(/root-1/);
		expect(message).not.toMatch(/tip-1/);
		expect(message).toMatch(/\/tree|trunk|still on/i);
	});
});
