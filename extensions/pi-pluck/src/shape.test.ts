import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "./notes.ts";
import { shape } from "./shape.ts";

function user(ts: number): AgentMessage {
	return { role: "user", content: "u" + ts, timestamp: ts } as unknown as AgentMessage;
}
function assistant(ts: number, toolCall = false): AgentMessage {
	const content = toolCall
		? [{ type: "toolCall", id: "call-" + ts, name: "bash", arguments: {} }]
		: [{ type: "text", text: "a" + ts }];
	return { role: "assistant", content, timestamp: ts } as unknown as AgentMessage;
}
function toolResult(ts: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-" + (ts - 1),
		content: [{ type: "text", text: "r" }],
		timestamp: ts,
	} as unknown as AgentMessage;
}
function summary(ts: number): AgentMessage {
	return { role: "compactionSummary", summary: "s", timestamp: ts } as unknown as AgentMessage;
}

/** user → assistant(toolCall) → toolResult → assistant, starting at `ts`. */
function turn(ts: number): AgentMessage[] {
	return [user(ts), assistant(ts + 1, true), toolResult(ts + 2), assistant(ts + 3)];
}

describe("shape", () => {
	test("empty forgotten set keeps every message, in order, same objects", () => {
		const messages = [...turn(100), ...turn(200)];
		const out = shape(messages, new Set());
		assert.deepEqual(out, messages);
		assert.notEqual(out, messages, "returns a new array");
		out.forEach((m, i) => assert.equal(m, messages[i]));
	});

	test("drops whole turns only: all four messages of a turn go together", () => {
		const t1 = turn(100);
		const t2 = turn(200);
		const t3 = turn(300);
		const out = shape([...t1, ...t2, ...t3], new Set([200]));
		assert.deepEqual(out, [...t1, ...t3]);
		for (const m of t2) assert.ok(!out.includes(m), "no message of the dropped turn survives");
		for (const m of [...t1, ...t3]) assert.ok(out.includes(m), "every message of kept turns survives");
	});

	test("timestamps of non-user messages never match", () => {
		const t1 = turn(100);
		// 101/102/103 are assistant/toolResult timestamps inside t1; only the user ts counts.
		assert.deepEqual(shape(t1, new Set([101, 102, 103])), t1);
	});

	test("leading non-user prefix is kept even when the first turn is dropped", () => {
		const prefix = [summary(1), assistant(2)];
		const t1 = turn(100);
		const t2 = turn(200);
		const out = shape([...prefix, ...t1, ...t2], new Set([100]));
		assert.deepEqual(out, [...prefix, ...t2]);
	});

	test("compactionSummary inside a turn goes with the turn", () => {
		const t1 = [user(100), summary(101), assistant(102)];
		const t2 = turn(200);
		assert.deepEqual(shape([...t1, ...t2], new Set([100])), t2);
	});

	test("dropping every turn leaves only the prefix", () => {
		const prefix = [assistant(1)];
		const out = shape([...prefix, ...turn(100), ...turn(200)], new Set([100, 200]));
		assert.deepEqual(out, prefix);
	});

	test("never mutates the input array or its messages", () => {
		const messages = [...turn(100), ...turn(200)];
		const snapshot = structuredClone(messages);
		shape(messages, new Set([100]));
		assert.deepEqual(messages, snapshot);
	});
});
