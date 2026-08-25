import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectForgotten, listOverlayNotes, type OverlayNote, type PluckNote } from "./notes.ts";

function custom(id: string, data: unknown, customType = "pi-pluck"): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		data,
	} as unknown as SessionEntry;
}
function userEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 1 },
	} as unknown as SessionEntry;
}
function overlay(...ts: number[]): OverlayNote {
	return {
		kind: "overlay",
		regexStr: "x",
		labelText: "plucked",
		forgotten: ts.map((t) => ({ ts: t, entryId: "e" + t })),
	};
}
function cancel(...noteIds: string[]): PluckNote {
	return { kind: "cancel", noteIds };
}
function sorted(set: ReadonlySet<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

describe("collectForgotten", () => {
	test("empty path → empty set", () => {
		assert.equal(collectForgotten([]).size, 0);
	});

	test("path without notes → empty set", () => {
		assert.equal(collectForgotten([userEntry("u1"), userEntry("u2")]).size, 0);
	});

	test("two overlays union", () => {
		const set = collectForgotten([
			userEntry("u1"),
			custom("n1", overlay(100, 200)),
			userEntry("u2"),
			custom("n2", overlay(300)),
		]);
		assert.deepEqual(sorted(set), [100, 200, 300]);
	});

	test("cancel removes exactly the named note's turns", () => {
		const set = collectForgotten([
			custom("n1", overlay(100, 200)),
			custom("n2", overlay(300)),
			custom("c1", cancel("n1")),
		]);
		assert.deepEqual(sorted(set), [300]);
	});

	test("a turn contributed by two overlays stays forgotten when one is cancelled", () => {
		const entries = [
			custom("n1", overlay(100, 200)),
			custom("n2", overlay(200, 300)),
			custom("c1", cancel("n1")),
		];
		assert.deepEqual(sorted(collectForgotten(entries)), [200, 300]);
		assert.deepEqual(sorted(collectForgotten([...entries, custom("c2", cancel("n2"))])), []);
	});

	test("cancelling the same note twice does not unforget a later overlay's turn", () => {
		const set = collectForgotten([
			custom("n1", overlay(100)),
			custom("c1", cancel("n1")),
			custom("c2", cancel("n1")),
			custom("n2", overlay(100)),
		]);
		assert.deepEqual(sorted(set), [100]);
	});

	test("cancel naming an unknown, later, or non-overlay id is ignored", () => {
		const set = collectForgotten([
			custom("c0", cancel("n1", "nope", "c0")),
			custom("n1", overlay(100)),
		]);
		assert.deepEqual(sorted(set), [100]);
	});

	test("unknown kinds, other custom types and malformed data are ignored", () => {
		const set = collectForgotten([
			custom("l1", { kind: "unknown", anchorId: "x" }),
			custom("o1", overlay(999), "other-extension"),
			custom("m1", null),
			custom("m2", "overlay"),
			custom("m3", { kind: "overlay" }),
			custom("m4", { kind: "overlay", forgotten: [{ ts: "100" }] }),
			custom("m5", { kind: "cancel", noteIds: "n1" }),
			custom("m6", { kind: "graft", fromTipId: "t" }),
			custom("m7", undefined),
			custom("n1", overlay(100)),
		]);
		assert.deepEqual(sorted(set), [100]);
	});
});

describe("listOverlayNotes", () => {
	test("lists overlays in path order with cancelled flag", () => {
		const n1 = overlay(100);
		const n2 = overlay(200);
		const out = listOverlayNotes([
			custom("c0", cancel("n2")), // earlier than n2: does not cancel it
			custom("n1", n1),
			custom("l1", { kind: "unknown" }),
			custom("n2", n2),
			custom("c1", cancel("n1")),
		]);
		assert.deepEqual(out, [
			{ id: "n1", note: n1, cancelled: true },
			{ id: "n2", note: n2, cancelled: false },
		]);
	});

	test("empty path → empty list", () => {
		assert.deepEqual(listOverlayNotes([]), []);
	});
});

describe("with a live SessionManager", () => {
	test("appendCustomEntry round-trips through getBranch()", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "one", timestamp: 100 });
		const n1 = sm.appendCustomEntry("pi-pluck", overlay(100));
		sm.appendMessage({ role: "user", content: "two", timestamp: 200 });
		const n2 = sm.appendCustomEntry("pi-pluck", overlay(200));
		sm.appendCustomEntry("pi-pluck", cancel(n1));

		const branch = sm.getBranch();
		assert.deepEqual(sorted(collectForgotten(branch)), [200]);
		assert.deepEqual(
			listOverlayNotes(branch).map((o) => [o.id, o.cancelled]),
			[
				[n1, true],
				[n2, false],
			],
		);
	});
});
