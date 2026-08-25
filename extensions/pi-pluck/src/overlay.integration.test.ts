import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	SessionManager,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { invalidate, registerHooks } from "./hooks.ts";
import { PLUCK_CUSTOM_TYPE, listOverlayNotes, type AgentMessage } from "./notes.ts";
import {
	buildCancelNote,
	buildLabelText,
	buildOverlayNote,
	planForgetfulRewrite,
	type Turn,
} from "./pluck-steps.ts";

/**
 * The three slices were built against frozen stubs in parallel. This test drives the real
 * pieces together the way a session does: /pluck builds a note from a plan, the note goes on
 * the branch, and the `context` handler shapes what pi would send — then /unpluck undoes it.
 */

type Handler = (event: any, ctx: any) => any;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

function appendUser(sm: SessionManager, text: string, ts: number): void {
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: ts });
}

function appendAssistant(sm: SessionManager, text: string, ts: number): void {
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts,
	} as any);
}

function turnsOf(entries: SessionEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: SessionEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (current.length > 0) turns.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function userTexts(messages: AgentMessage[]): string[] {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => (m.content as Array<{ text: string }>)[0]!.text);
}

describe("overlay end to end", () => {
	test("/pluck note shapes the context; /unpluck restores it; the file keeps everything", () => {
		invalidate();
		const sm = SessionManager.inMemory();
		appendUser(sm, "hello", 1_000);
		appendAssistant(sm, "hi", 1_001);
		appendUser(sm, "talk about banana", 2_000);
		appendAssistant(sm, "about banana", 2_001);
		appendUser(sm, "continue", 3_000);
		appendAssistant(sm, "continuing", 3_001);

		const { pi, handlers } = fakePi();
		registerHooks(pi);
		const ctx = { sessionManager: sm } as unknown as ExtensionContext;
		const context = handlers.get("context")!;
		const messagesFor = () => buildSessionContext(sm.getEntries(), sm.getLeafId()).messages;

		// No notes: the handler is a no-op.
		assert.equal(context({ messages: messagesFor() }, ctx), undefined);

		// /pluck banana
		const turns = turnsOf(sm.getBranch() as SessionEntry[]);
		const plan = planForgetfulRewrite(turns, /banana/i, "banana");
		assert.ok(plan.ok);
		if (!plan.ok) return;
		const labelText = buildLabelText(plan, "12:00");
		sm.appendCustomEntry(PLUCK_CUSTOM_TYPE, buildOverlayNote(turns, plan, labelText));
		const noteId = sm.getLeafId()!;
		invalidate();

		const shaped = context({ messages: messagesFor() }, ctx);
		assert.deepEqual(userTexts(shaped.messages), ["hello", "continue"]);
		// Whole turn gone: the assistant reply about banana went with its prompt.
		assert.equal(shaped.messages.some((m: any) => m.content?.[0]?.text === "about banana"), false);

		// The session file still has everything.
		assert.deepEqual(userTexts(messagesFor()), ["hello", "talk about banana", "continue"]);
		assert.equal(listOverlayNotes(sm.getBranch() as SessionEntry[])[0]!.cancelled, false);

		// /unpluck
		sm.appendCustomEntry(PLUCK_CUSTOM_TYPE, buildCancelNote(noteId));
		invalidate();
		assert.equal(context({ messages: messagesFor() }, ctx), undefined);
		assert.equal(listOverlayNotes(sm.getBranch() as SessionEntry[])[0]!.cancelled, true);
	});
});
