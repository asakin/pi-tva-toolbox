import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { forkOff, parseSlugs } from "./index.ts";

/**
 * Where Pi puts the leaf when you select an entry in `/tree`.
 *
 * Mirrors `AgentSession.navigateTree()`: a user message or a `custom_message` is treated
 * as "rewind to before this and let me retype it", so the leaf becomes the selected
 * entry's parent; anything else is a landing spot and the leaf becomes the entry itself.
 * Kept here as the executable statement of the rule this extension is built around — the
 * original bug was a shape that ignored it.
 */
function leafAfterNavigatingTo(entry: SessionEntry): string | null | undefined {
  if (entry.type === "message" && entry.message.role === "user") return entry.parentId;
  if (entry.type === "custom_message") return entry.parentId;
  return entry.id;
}

function withSession(run: (sm: SessionManager, baseId: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fork-off-test-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "set up the project", timestamp: 0 });
    // Pi keeps a session in memory until it holds an assistant message
    // (`SessionManager._persist()`), so the reply is what makes the file exist — without
    // it the resume test would be checking an unwritten file.
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    });
    const baseId = sm.getLeafId();
    assert.ok(baseId, "seeded session should have a leaf");
    run(sm, baseId, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseSlugs: a bare number means that many numbered branches", () => {
  assert.deepEqual(parseSlugs("3"), { slugs: ["Branch 1", "Branch 2", "Branch 3"] });
});

test("parseSlugs: names are whitespace-separated", () => {
  assert.deepEqual(parseSlugs("  redis   in-memory "), { slugs: ["redis", "in-memory"] });
});

test("parseSlugs: rejects empty input, zero, and over-max", () => {
  assert.ok("error" in parseSlugs(""));
  assert.ok("error" in parseSlugs("0"));
  assert.ok("error" in parseSlugs("21"));
  assert.ok("error" in parseSlugs(new Array(21).fill("x").join(" ")));
});

test("every branch forks from the base as a sibling", () => {
  withSession((sm, baseId) => {
    const { branches } = forkOff(sm, baseId, ["a", "b", "c"], new Date(0));

    assert.equal(branches.length, 3);
    for (const branch of branches) {
      const head = sm.getEntry(branch.headId);
      assert.ok(head, "head entry exists");
      assert.equal(head.parentId, baseId, "each branch head is a direct child of the base");
    }
    const headIds = new Set(branches.map((b) => b.headId));
    assert.equal(headIds.size, 3, "branches are distinct, not a chain");
  });
});

test("the labeled marker sits below the head and carries the slug", () => {
  withSession((sm, baseId) => {
    const { branches } = forkOff(sm, baseId, ["redis"], new Date(0));
    const branch = branches[0]!;

    const marker = sm.getEntry(branch.markerId);
    assert.ok(marker);
    assert.equal(marker.parentId, branch.headId, "marker is a child of the head");
    assert.match(sm.getLabel(branch.markerId) ?? "", /redis$/, "marker carries the slug label");
    assert.equal(sm.getLabel(branch.headId), undefined, "the head itself is not labeled");
  });
});

test("REGRESSION: selecting a branch in /tree lands inside that branch, not on the base", () => {
  withSession((sm, baseId) => {
    const { branches } = forkOff(sm, baseId, ["a", "b"], new Date(0));

    for (const branch of branches) {
      const marker = sm.getEntry(branch.markerId);
      assert.ok(marker);
      const landed = leafAfterNavigatingTo(marker);

      assert.equal(landed, branch.headId, "navigation lands on the branch head");
      assert.notEqual(landed, baseId, "navigation must not fall back to the shared base");

      // The brief is on the path from the landing point, so the model is told which
      // branch it is on.
      const path = sm.getBranch(landed ?? undefined).map((e) => e.id);
      assert.ok(path.includes(branch.headId), "the branch brief is in context");
      assert.ok(path.includes(baseId), "prior history is preserved");
    }
  });
});

test("the marker prefills nothing into the editor", () => {
  withSession((sm, baseId) => {
    const { branches } = forkOff(sm, baseId, ["a"], new Date(0));
    const marker = sm.getEntry(branches[0]!.markerId);
    assert.ok(marker && marker.type === "custom_message");
    // Pi only prefills the editor when the recovered text is non-empty.
    assert.equal(marker.content, "");
  });
});

test("the in-memory leaf is left on the base", () => {
  withSession((sm, baseId) => {
    forkOff(sm, baseId, ["a", "b"], new Date(0));
    const leaf = sm.getLeafId();
    assert.ok(leaf);
    const path = sm.getBranch(leaf).map((e) => e.id);
    assert.ok(path.includes(baseId), "leaf is on the trunk");
  });
});

test("REGRESSION: resuming the session returns to the trunk, not the last branch", () => {
  withSession((sm, baseId, dir) => {
    const { branches } = forkOff(sm, baseId, ["a", "b", "c"], new Date(0));
    const file = sm.getSessionFile();
    assert.ok(file, "session persisted to a file");

    // A session's persisted position is its last line, so this is the real check.
    const reopened = SessionManager.open(file, dir);
    const leaf = reopened.getLeafId();
    assert.ok(leaf);

    const path = reopened.getBranch(leaf).map((e) => e.id);
    assert.ok(path.includes(baseId), "resumed position is on the trunk");
    for (const branch of branches) {
      assert.ok(!path.includes(branch.headId), `resume must not land inside branch ${branch.slug}`);
    }
  });
});
