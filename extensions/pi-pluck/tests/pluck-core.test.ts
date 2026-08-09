import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import registerPluck from "../index.ts";
import {
	applyForgetfulBranch,
	buildClones,
	buildConfirmMessage,
	buildLabelText,
	chunkTurns,
	entryMatchText,
	planPluck,
	remapClonedEntry,
	turnMatches,
} from "../src/pluck-core.ts";

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

function modelChange(id: string, parentId: string | null): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		provider: "test",
		modelId: "test-model",
	} as SessionEntry;
}

function compaction(
	id: string,
	parentId: string | null,
	firstKeptEntryId: string,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	} as SessionEntry;
}

/** Synthetic linear chat — never touches disk or real Pi sessions. */
function samplePath(): SessionEntry[] {
	const u1 = msg("u1", null, "user", "hello world");
	const a1 = msg("a1", "u1", "assistant", [
		{ type: "text", text: "hi there" },
		{
			type: "toolCall",
			name: "write",
			arguments: { path: "secret-file.ts" },
		},
	]);
	const tr1 = msg("tr1", "a1", "toolResult", "file contents should not match");
	const u2 = msg("u2", "tr1", "user", "continue please");
	const a2 = msg("a2", "u2", "assistant", [
		{ type: "text", text: "continuing" },
	]);
	const u3 = msg("u3", "a2", "user", "banana-pluck-marker");
	const a3 = msg("a3", "u3", "assistant", [
		{ type: "text", text: "got the marker" },
	]);
	return [u1, a1, tr1, u2, a2, u3, a3];
}

describe("entryMatchText / turnMatches", () => {
	test("matches user and assistant text, and tool call name/args", () => {
		const path = samplePath();
		expect(entryMatchText(path[0]!)).toContain("hello world");
		expect(entryMatchText(path[1]!)).toContain("write");
		expect(entryMatchText(path[1]!)).toContain("secret-file.ts");
		expect(entryMatchText(path[2]!)).toBe(""); // toolResult excluded
		expect(turnMatches([path[1]!, path[2]!], /secret-file/)).toBe(true);
		expect(turnMatches([path[1]!, path[2]!], /file contents/)).toBe(false);
	});

	test("empty match corpus does not match empty-friendly regexes", () => {
		const preamble = [modelChange("m0", null)];
		expect(turnMatches(preamble, /^$/)).toBe(false);
		expect(turnMatches(preamble, /.*/)).toBe(false);
		expect(turnMatches(preamble, /a?/)).toBe(false);
	});
});

describe("chunkTurns", () => {
	test("splits on user messages and keeps preamble as its own turn", () => {
		const path = [modelChange("m0", null), ...samplePath()];
		const turns = chunkTurns(path);
		expect(turns).toHaveLength(4); // preamble + 3 user turns
		expect(turns[0]!.map((e) => e.id)).toEqual(["m0"]);
		expect(turns[1]!.map((e) => e.id)).toEqual(["u1", "a1", "tr1"]);
		expect(turns[2]!.map((e) => e.id)).toEqual(["u2", "a2"]);
		expect(turns[3]!.map((e) => e.id)).toEqual(["u3", "a3"]);
	});
});

describe("planPluck", () => {
	test("no_match when regex hits nothing", () => {
		const plan = planPluck(samplePath(), /zzzz-absent/);
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.reason).toBe("no_match");
	});

	test("plucks a middle turn and clones the suffix", () => {
		const path = samplePath();
		const plan = planPluck(path, /continue please/);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.skippedCount).toBe(1);
		expect(plan.originalTurnCount).toBe(3);
		expect(plan.rootProtected).toBe(false);
		expect(plan.labelOnly).toBe(false);
		expect(plan.divergenceParentId).toBe("tr1"); // last shared before cut
		expect(plan.toClone.map((e) => e.id)).toEqual(["u3", "a3"]);
		expect(plan.keptTurnCount).toBe(2); // turn1 + turn3
	});

	test("root-protect keeps initial user prompt only", () => {
		const path = samplePath();
		const plan = planPluck(path, /hello world/);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.rootProtected).toBe(true);
		expect(plan.skippedCount).toBe(1);
		expect(plan.divergenceParentId).toBe("u1");
		expect(plan.toClone.map((e) => e.id)).toEqual([
			"u2",
			"a2",
			"u3",
			"a3",
		]);
		// "after that" excludes the protected partial root turn
		expect(plan.keptTurnCount).toBe(2);
	});

	test("label-only when everything after divergence is plucked", () => {
		const path = samplePath();
		const plan = planPluck(path, /continue please|banana-pluck-marker/);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.labelOnly).toBe(true);
		expect(plan.toClone).toHaveLength(0);
		expect(plan.skippedCount).toBe(2);
		expect(plan.divergenceParentId).toBe("tr1");
	});

	test("tool-call args match without toolResult text", () => {
		const plan = planPluck(samplePath(), /secret-file\.ts/);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.rootProtected).toBe(true); // first turn contains the toolCall
		expect(plan.skippedCount).toBe(1);
	});
});

describe("remapClonedEntry / buildClones", () => {
	test("reparents across plucked gap and remaps ids", () => {
		const path = samplePath();
		const plan = planPluck(path, /continue please/);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		const clones = buildClones(
			plan,
			path.map((e) => e.id),
		);
		expect(clones).toHaveLength(2);
		expect(clones[0]!.parentId).toBe(plan.divergenceParentId);
		expect(clones[1]!.parentId).toBe(clones[0]!.id);
		expect(new Set(clones.map((c) => c.id)).size).toBe(2);
		for (const c of clones) {
			expect(path.some((e) => e.id === c.id)).toBe(false);
		}
	});

	test("stale compaction ref falls back to divergence parent", () => {
		const entry = compaction("c1", "u2", "plucked-id");
		const idMap = new Map([["c1", "c1-new"]]);
		const onPathIds = new Set(["u1"]);
		const clone = remapClonedEntry(entry, idMap, "u1", onPathIds);
		expect(clone.type).toBe("compaction");
		if (clone.type === "compaction") {
			expect(clone.firstKeptEntryId).toBe("u1");
		}
	});
});

describe("label + confirm copy", () => {
	test("buildLabelText uses X/Y", () => {
		expect(
			buildLabelText({
				skippedCount: 2,
				originalTurnCount: 5,
				regexStr: "foo",
				labelTime: "17:42",
			}),
		).toBe("plucked 2/5 /foo/ 17:42");
	});

	test("confirm mentions root-protect and stay-put", () => {
		const text = buildConfirmMessage({
			regexStr: "hi",
			skippedCount: 1,
			keptTurnCount: 2,
			rootProtected: true,
			labelOnly: false,
		});
		expect(text).toContain("initial user prompt");
		expect(text).toContain("keeps 2 turn(s) after that");
		expect(text).toContain("/tree");
	});
});

describe("applyForgetfulBranch (SessionManager.inMemory)", () => {
	test("creates a side-branch tip and does not label the current leaf", async () => {
		const { SessionManager } = await import(
			`${dirname(await realpath(Bun.which("pi")!))}/core/session-manager.js`
		);
		const sm = SessionManager.inMemory();
		const ts = () => new Date().toISOString();
		sm.appendMessage({ role: "user", content: "start", timestamp: ts() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: ts(),
		});
		sm.appendMessage({
			role: "user",
			content: "please use Context7",
			timestamp: ts(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Context7 result" }],
			timestamp: ts(),
		});
		sm.appendMessage({ role: "user", content: "keep this", timestamp: ts() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "kept" }],
			timestamp: ts(),
		});

		const originalLeafId = sm.getLeafId()!;
		const path = sm.getBranch();
		const plan = planPluck(path as SessionEntry[], /Context7/i);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		const labelText = buildLabelText({
			skippedCount: plan.skippedCount,
			originalTurnCount: plan.originalTurnCount,
			regexStr: "Context7",
			labelTime: "12:00",
		});

		const before = sm.getEntries().length;
		const { tipId, cloneCount } = applyForgetfulBranch({
			sm,
			plan,
			originalLeafId,
			labelText,
		});

		expect(sm.getLeafId()).toBe(originalLeafId);
		expect(tipId).not.toBe(originalLeafId);
		expect(tipId).not.toBe(plan.divergenceParentId);
		expect(cloneCount).toBeGreaterThan(0);
		expect(sm.getLabel(tipId)).toBe(labelText);
		expect(sm.getLabel(originalLeafId)).toBeUndefined();
		expect(sm.getEntries().length).toBeGreaterThan(before + cloneCount);

		const tip = sm.getEntry(tipId);
		expect(tip?.type).toBe("custom_message");

		// Side-branch: divergence has ≥2 children (original continuation + forgetful chain)
		const kids = sm
			.getEntries()
			.filter((e: SessionEntry) => e.parentId === plan.divergenceParentId);
		expect(kids.length).toBeGreaterThanOrEqual(2);

		// Walk tip → root and ensure we pass through divergence
		let cur: string | null | undefined = tipId;
		const seen = new Set<string>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			if (cur === plan.divergenceParentId) break;
			cur = sm.getEntry(cur)?.parentId ?? null;
		}
		expect(seen.has(plan.divergenceParentId)).toBe(true);
	});

	test("label-only pluck still gets a fresh tip, not the divergence parent", async () => {
		const { SessionManager } = await import(
			`${dirname(await realpath(Bun.which("pi")!))}/core/session-manager.js`
		);
		const sm = SessionManager.inMemory();
		const ts = () => new Date().toISOString();
		sm.appendMessage({ role: "user", content: "start", timestamp: ts() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: ts(),
		});
		sm.appendMessage({
			role: "user",
			content: "drop this turn Context7",
			timestamp: ts(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "bye" }],
			timestamp: ts(),
		});

		const originalLeafId = sm.getLeafId()!;
		const plan = planPluck(sm.getBranch() as SessionEntry[], /Context7/i);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.labelOnly).toBe(true);

		const labelText = "plucked 1/2 /Context7/ 12:00";
		const { tipId, cloneCount } = applyForgetfulBranch({
			sm,
			plan,
			originalLeafId,
			labelText,
		});

		expect(cloneCount).toBe(0);
		expect(tipId).not.toBe(plan.divergenceParentId);
		expect(tipId).not.toBe(originalLeafId);
		expect(sm.getLabel(tipId)).toBe(labelText);
		expect(sm.getLabel(plan.divergenceParentId)).toBeUndefined();
		expect(sm.getLeafId()).toBe(originalLeafId);
	});
});

describe("extension load smoke", () => {
	test("registers /pluck without touching a session", () => {
		const registered: string[] = [];
		const pi = {
			registerCommand(name: string) {
				registered.push(name);
			},
			setLabel() {
				throw new Error("setLabel should not run during load");
			},
		};
		registerPluck(pi as never);
		expect(registered).toEqual(["pluck"]);
	});

	test("loads through Pi's jiti loader (no session I/O)", async () => {
		const piBin = Bun.which("pi");
		expect(piBin).toBeTruthy();
		const cliPath = await realpath(piBin!);
		const agentDist = dirname(cliPath);
		const { loadExtensions, createExtensionRuntime } = await import(
			`${agentDist}/core/extensions/index.js`
		);
		const { createEventBus } = await import(`${agentDist}/core/event-bus.js`);

		const extPath = fileURLToPath(new URL("../index.ts", import.meta.url));
		const result = await loadExtensions(
			[extPath],
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(result.errors).toEqual([]);
		const commands = result.extensions.flatMap((e: { commands: Map<string, unknown> }) => [
			...e.commands.keys(),
		]);
		expect(commands).toContain("pluck");
	});
});
