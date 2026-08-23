import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { displayPath, getSubdirectories, reconstructBranch, userMessageText } from "./index.ts";

test("userMessageText: strings pass through, text parts join, images drop", () => {
  assert.equal(userMessageText("hi"), "hi");
  assert.equal(
    userMessageText([
      { type: "text", text: "a" },
      { type: "image", data: "..." },
      { type: "text", text: "b" },
    ]),
    "ab"
  );
  assert.equal(userMessageText(42), "");
  assert.equal(userMessageText(null), "");
});

test("displayPath: collapses only a leading home path", () => {
  const home = homedir();
  assert.equal(displayPath(home), "~");
  assert.equal(displayPath(join(home, "x", "y")), "~" + sep + "x" + sep + "y");
  assert.equal(displayPath(home + "stuff"), home + "stuff");
  assert.equal(displayPath(join("/tmp", home, "x")), join("/tmp", home, "x"));
});

test("getSubdirectories: visible dirs only, sorted, trailing slash; [] on error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heist-"));
  try {
    mkdirSync(join(dir, "b"));
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "file.txt"), "");
    assert.deepEqual(await getSubdirectories(dir), ["a/", "b/"]);
    assert.deepEqual(await getSubdirectories(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Minimal entries: reconstructBranch only reads id and parentId.
function entry(id: string, parentId: string | null): SessionEntry {
  return { id, parentId, type: "message" } as unknown as SessionEntry;
}

test("reconstructBranch: root-first path to the selection, siblings excluded", () => {
  const a = entry("a", null);
  const b = entry("b", "a");
  const c = entry("c", "b");
  const side = entry("side", "a");
  const entries = [side, c, a, b]; // deliberately unordered

  assert.deepEqual(reconstructBranch(entries, c, "at").map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(reconstructBranch(entries, c, "before").map((e) => e.id), ["a", "b"]);
  assert.deepEqual(reconstructBranch(entries, a, "before"), []);
});

test("reconstructBranch: stops at a dangling parent instead of throwing", () => {
  const orphan = entry("o", "gone");
  const child = entry("k", "o");
  assert.deepEqual(reconstructBranch([orphan, child], child, "at").map((e) => e.id), ["o", "k"]);
});
