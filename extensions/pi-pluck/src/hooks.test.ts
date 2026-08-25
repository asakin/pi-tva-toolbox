import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forgottenFor, invalidate, registerHooks, type HookDeps } from "./hooks.ts";
import type { AgentMessage, ForgottenSet } from "./notes.ts";

type LiveSession = ReturnType<typeof SessionManager.inMemory>;
type Handler = (event: any, ctx: any) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function user(ts: number, text = `u${ts}`): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as AgentMessage;
}

function appendUser(sm: LiveSession, ts: number): void {
	sm.appendMessage({ role: "user", content: `u${ts}`, timestamp: ts });
}

function appendNote(sm: LiveSession): void {
	sm.appendCustomEntry("pi-pluck", { kind: "overlay", forgotten: [] });
}

/** Fake shape: drops user messages whose timestamp is forgotten (no turn grouping). */
const fakeShape: NonNullable<HookDeps["shape"]> = (messages, forgotten) =>
	messages.filter((m) => !(m.role === "user" && forgotten.has(m.timestamp)));

function makeCtx(
	sm: LiveSession,
	overrides: Partial<{
		model: unknown;
		auth: unknown;
		thinkingLevel: string;
	}> = {},
): ExtensionContext {
	return {
		sessionManager: sm,
		model: "model" in overrides ? overrides.model : { id: "m", provider: "p" },
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				"auth" in overrides ? overrides.auth : { ok: true, apiKey: "k" },
		},
		thinkingLevel: overrides.thinkingLevel,
	} as unknown as ExtensionContext;
}

/** Register hooks with a collectForgotten that returns `set` and counts calls. */
function setup(set: ForgottenSet, extra: HookDeps = {}) {
	invalidate();
	const { pi, handlers } = fakePi();
	let collectCalls = 0;
	registerHooks(pi, {
		shape: fakeShape,
		collectForgotten: () => {
			collectCalls++;
			return set;
		},
		...extra,
	});
	return { handlers, collectCalls: () => collectCalls };
}

function compactEvent(
	overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "keep-1",
			messagesToSummarize: [user(1), user(2), user(3)],
			turnPrefixMessages: [user(2), user(4)],
			isSplitTurn: true,
			tokensBefore: 1234,
			fileOps: { read: [], written: [] },
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
		} as unknown as SessionBeforeCompactEvent["preparation"],
		branchEntries: [],
		customInstructions: "focus",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

describe("registerHooks", () => {
	test("registers context, session_before_compact and session_start", () => {
		const { handlers } = setup(new Set());
		assert.deepEqual(
			[...handlers.keys()].sort(),
			["context", "session_before_compact", "session_start"],
		);
	});
});

describe("context handler", () => {
	test("returns shaped messages when turns are forgotten", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { handlers } = setup(new Set([2]));
		const result = handlers.get("context")!(
			{ type: "context", messages: [user(1), user(2), user(3)] },
			makeCtx(sm),
		) as { messages: AgentMessage[] };
		assert.deepEqual(
			result.messages.map((m) => m.timestamp),
			[1, 3],
		);
	});

	test("returns undefined when nothing is forgotten", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		const { handlers } = setup(new Set());
		const result = handlers.get("context")!(
			{ type: "context", messages: [user(1)] },
			makeCtx(sm),
		);
		assert.equal(result, undefined);
	});
});

describe("session_before_compact handler", () => {
	test("returns undefined when no notes", async () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		let called = false;
		const { handlers } = setup(new Set(), {
			compact: (async () => {
				called = true;
				return {} as never;
			}) as never,
		});
		const result = await handlers.get("session_before_compact")!(compactEvent(), makeCtx(sm));
		assert.equal(result, undefined);
		assert.equal(called, false);
	});

	test("returns undefined when no model", async () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { handlers } = setup(new Set([2]));
		const result = await handlers.get("session_before_compact")!(
			compactEvent(),
			makeCtx(sm, { model: undefined }),
		);
		assert.equal(result, undefined);
	});

	test("returns undefined when auth is not ok", async () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { handlers } = setup(new Set([2]));
		const result = await handlers.get("session_before_compact")!(
			compactEvent(),
			makeCtx(sm, { auth: { ok: false, error: "no key" } }),
		);
		assert.equal(result, undefined);
	});

	test("compacts the shaped preparation and passes through result", async () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const calls: unknown[][] = [];
		const { handlers } = setup(new Set([2]), {
			compact: (async (...args: unknown[]) => {
				calls.push(args);
				const prep = args[0] as SessionBeforeCompactEvent["preparation"];
				return {
					summary: "sum",
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
				};
			}) as never,
		});
		const event = compactEvent();
		const ctx = makeCtx(sm, {
			auth: { ok: true, apiKey: "key", headers: { h: "1", gone: null }, baseUrl: "http://b", env: { E: "1" } },
			thinkingLevel: "high",
		});
		const result = (await handlers.get("session_before_compact")!(event, ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number };
		};

		assert.equal(calls.length, 1);
		const [prep, model, apiKey, headers, instructions, signal, thinking, streamFn, env] =
			calls[0]!;
		const p = prep as SessionBeforeCompactEvent["preparation"];
		assert.deepEqual(p.messagesToSummarize.map((m) => m.timestamp), [1, 3]);
		assert.deepEqual(p.turnPrefixMessages.map((m) => m.timestamp), [4]);
		assert.equal(p.isSplitTurn, true);
		assert.deepEqual(model, { id: "m", provider: "p", baseUrl: "http://b" });
		assert.equal(apiKey, "key");
		assert.deepEqual(headers, { h: "1" });
		assert.equal(instructions, "focus");
		assert.equal(signal, event.signal);
		assert.equal(thinking, "high");
		assert.equal(streamFn, undefined);
		assert.deepEqual(env, { E: "1" });

		assert.deepEqual(result, {
			compaction: { summary: "sum", firstKeptEntryId: "keep-1", tokensBefore: 1234 },
		});
		// The original preparation is untouched.
		assert.equal(event.preparation.messagesToSummarize.length, 3);
	});

	test("returns undefined when compact throws", async () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { handlers } = setup(new Set([2]), {
			compact: (async () => {
				throw new Error("boom");
			}) as never,
		});
		const result = await handlers.get("session_before_compact")!(compactEvent(), makeCtx(sm));
		assert.equal(result, undefined);
	});
});

describe("forgottenFor cache", () => {
	test("hits on same leaf and note count, misses after a new note", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { collectCalls } = setup(new Set([1]));
		const ctx = makeCtx(sm);
		forgottenFor(ctx);
		forgottenFor(ctx);
		assert.equal(collectCalls(), 1);
		appendNote(sm);
		forgottenFor(ctx);
		assert.equal(collectCalls(), 2);
	});

	test("misses after invalidate()", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { collectCalls } = setup(new Set([1]));
		const ctx = makeCtx(sm);
		forgottenFor(ctx);
		invalidate();
		forgottenFor(ctx);
		assert.equal(collectCalls(), 2);
	});

	test("misses when the leaf moves without a new note", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { collectCalls } = setup(new Set([1]));
		const ctx = makeCtx(sm);
		forgottenFor(ctx);
		appendUser(sm, 2);
		forgottenFor(ctx);
		assert.equal(collectCalls(), 2);
	});

	test("never calls collectForgotten when the path has no notes", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		const { collectCalls } = setup(new Set([1]));
		const set = forgottenFor(makeCtx(sm));
		assert.equal(set.size, 0);
		assert.equal(collectCalls(), 0);
	});

	test("session_start invalidates", () => {
		const sm = SessionManager.inMemory();
		appendUser(sm, 1);
		appendNote(sm);
		const { handlers, collectCalls } = setup(new Set([1]));
		const ctx = makeCtx(sm);
		forgottenFor(ctx);
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		forgottenFor(ctx);
		assert.equal(collectCalls(), 2);
	});
});
