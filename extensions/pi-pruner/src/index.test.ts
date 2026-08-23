import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectDoomed } from "./index.ts";

// Minimal entries: collectDoomed only reads id and parentId.
function entry(id: string, parentId: string | null): SessionEntry {
  return { id, parentId, type: "message" } as unknown as SessionEntry;
}

//   root
//   ├── keep ── keep2
//   └── cut ── cut2 ── cut3
//        └── cut2b
const tree = [
  entry("root", null),
  entry("keep", "root"),
  entry("keep2", "keep"),
  entry("cut", "root"),
  entry("cut2", "cut"),
  entry("cut3", "cut2"),
  entry("cut2b", "cut"),
];

test("collectDoomed: a root and all its descendants, nothing else", () => {
  const doomed = collectDoomed(tree, ["cut"]);
  assert.deepEqual([...doomed].sort(), ["cut", "cut2", "cut2b", "cut3"]);
});

test("collectDoomed: nested roots do not double-count; unknown ids are inert", () => {
  const doomed = collectDoomed(tree, ["cut", "cut2", "nope"]);
  assert.deepEqual([...doomed].sort(), ["cut", "cut2", "cut2b", "cut3", "nope"]);
});

test("collectDoomed: no roots → empty", () => {
  assert.equal(collectDoomed(tree, []).size, 0);
});
