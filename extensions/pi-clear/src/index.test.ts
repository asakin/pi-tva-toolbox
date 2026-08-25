import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import registerClear, { findFirstUser } from "./index.ts";

function user(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "user", content: text },
	} as unknown as SessionEntry;
}
function assistant(id: string, parentId: string | null): SessionEntry {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "assistant", content: [] },
	} as unknown as SessionEntry;
}
function lookup(entries: SessionEntry[]) {
	const map = new Map(entries.map((e) => [e.id, e]));
	return (id: string) => map.get(id);
}

test("findFirstUser: walks leaf → root and keeps the earliest user message", () => {
	const entries = [user("u1", null, "seed"), assistant("a1", "u1"), user("u2", "a1", "next"), assistant("a2", "u2")];
	const found = findFirstUser("a2", lookup(entries));
	assert.equal(found?.id, "u1");
	assert.equal(found?.parentId, null);
	assert.equal(found?.message.content, "seed");
});

test("findFirstUser: only the current branch counts, not a sibling", () => {
	const entries = [user("u1", null, "seed"), user("side", "u1", "other"), assistant("a1", "u1")];
	assert.equal(findFirstUser("a1", lookup(entries))?.id, "u1");
	assert.equal(findFirstUser("side", lookup(entries))?.id, "u1");
});

test("findFirstUser: null when the branch has no user message or the leaf is unknown", () => {
	assert.equal(findFirstUser("a1", lookup([assistant("a1", null)])), null);
	assert.equal(findFirstUser("ghost", lookup([])), null);
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand(name: string, spec: { handler: Handler }) {
			handlers.set(name, spec.handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function fakeCtx(opts: {
	entries: SessionEntry[];
	leafId: string | null;
	idle?: boolean;
	navigate?: () => Promise<{ cancelled: boolean }>;
}) {
	const notices: string[] = [];
	const navigations: Array<{ targetId: string; options: unknown }> = [];
	let editorText: string | undefined;
	const get = lookup(opts.entries);
	const ctx = {
		sessionManager: { getLeafId: () => opts.leafId, getEntry: get },
		isIdle: () => opts.idle ?? true,
		ui: {
			notify: (text: string) => notices.push(text),
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
		navigateTree: async (targetId: string, options: unknown) => {
			navigations.push({ targetId, options });
			return opts.navigate ? opts.navigate() : { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices, navigations, editorText: () => editorText };
}

function clearHandler(): Handler {
	const { pi, handlers } = fakePi();
	registerClear(pi);
	const handler = handlers.get("clear");
	assert.ok(handler, "registers /clear");
	return handler;
}

const branch = [user("u1", null, "seed"), assistant("a1", "u1"), user("u2", "a1", "next"), assistant("a2", "u2")];

test("/clear: rewinds to the first user message, blanks the editor, and notifies", async () => {
	const { ctx, notices, navigations, editorText } = fakeCtx({ entries: branch, leafId: "a2" });
	await clearHandler()("", ctx);
	assert.equal(navigations.length, 1);
	assert.equal(navigations[0]?.targetId, "u1");
	const options = navigations[0]?.options as { summarize: boolean; label: string };
	assert.equal(options.summarize, false);
	assert.match(options.label, /^⌛ clear \d\d:\d\d$/);
	assert.equal(editorText(), "");
	assert.deepEqual(notices, ["Cleared. The old branch is still in /tree."]);
});

test("/clear: refuses while the agent is streaming", async () => {
	const { ctx, notices, navigations } = fakeCtx({ entries: branch, leafId: "a2", idle: false });
	await clearHandler()("", ctx);
	assert.equal(navigations.length, 0);
	assert.match(notices[0] ?? "", /finish its turn/);
});

test("/clear: does nothing on an empty session or when already at the first user message", async () => {
	const empty = fakeCtx({ entries: [], leafId: null });
	await clearHandler()("", empty.ctx);
	assert.equal(empty.navigations.length, 0);
	assert.match(empty.notices[0] ?? "", /no entries/);

	const atHead = fakeCtx({ entries: branch, leafId: "u1" });
	await clearHandler()("", atHead.ctx);
	assert.equal(atHead.navigations.length, 0);
	assert.match(atHead.notices[0] ?? "", /already at the beginning/);
});

test("/clear: a cancelled navigation leaves the editor alone", async () => {
	const { ctx, notices, editorText } = fakeCtx({
		entries: branch,
		leafId: "a2",
		navigate: async () => ({ cancelled: true }),
	});
	await clearHandler()("", ctx);
	assert.equal(editorText(), undefined);
	assert.deepEqual(notices, []);
});

test("/clear: a failed navigation is reported, not thrown", async () => {
	const { ctx, notices, editorText } = fakeCtx({
		entries: branch,
		leafId: "a2",
		navigate: async () => {
			throw new Error("boom");
		},
	});
	await clearHandler()("", ctx);
	assert.equal(editorText(), undefined);
	assert.deepEqual(notices, ["clear failed: boom"]);
});
