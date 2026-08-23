import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findFirstUser } from "./index.ts";

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
