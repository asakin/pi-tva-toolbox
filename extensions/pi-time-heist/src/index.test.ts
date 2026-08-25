import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { SessionEntry, SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";

// The lib logger and pi's default session store both resolve under the agent
// dir; point it at a temp dir before the module loads so tests never touch ~/.pi.
const agentDir = mkdtempSync(join(tmpdir(), "heist-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const { default: register, displayPath, getSubdirectories, reconstructBranch, targetSessionDir, userMessageText } =
  await import("./index.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

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

// ---- flow: session_before_fork hook and /heist against a fake pi/ctx ----

type ForkHandler = (
  event: { type: "session_before_fork"; entryId: string; position: "before" | "at" },
  ctx: any
) => Promise<{ cancel: true } | undefined>;

// Registers the extension once and exposes what it hooked and registered.
function loadExtension() {
  let forkHandler: ForkHandler | undefined;
  let heist: ((args: string, ctx: any) => Promise<void>) | undefined;
  register({
    on: (event: string, handler: any) => {
      if (event === "session_before_fork") forkHandler = handler;
    },
    registerCommand: (name: string, cmd: any) => {
      if (name === "heist") heist = cmd.handler;
    },
  } as any);
  return { forkHandler: forkHandler!, heist: heist! };
}

function fakeCtx(sessionManager: SessionManagerType, selections: (string | undefined)[]) {
  const notices: string[] = [];
  const titles: string[] = [];
  const switched: { path: string; editorText?: string; notices: string[] }[] = [];
  const ctx = {
    hasUI: true,
    cwd: sessionManager.getCwd(),
    sessionManager,
    ui: {
      select: async (title: string) => {
        titles.push(title);
        return selections.shift();
      },
      notify: (text: string) => notices.push(text),
    },
    switchSession: async (path: string, options?: { withSession?: (c: any) => Promise<void> }) => {
      const record: (typeof switched)[number] = { path, notices: [] };
      switched.push(record);
      await options?.withSession?.({
        ui: {
          setEditorText: (t: string) => (record.editorText = t),
          notify: (text: string) => record.notices.push(text),
        },
      });
      return { cancelled: false };
    },
  };
  return { ctx, notices, titles, switched };
}

// A source session with two user turns; returns the manager and the entry ids.
function sourceSession(cwd: string, sessionDir?: string) {
  const sm = SessionManager.create(cwd, sessionDir);
  const first = sm.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const second = sm.appendMessage({ role: "user", content: "second", timestamp: 2 });
  return { sm, first, second };
}

test("hook: no UI means no picker and the native fork proceeds", async () => {
  const { forkHandler } = loadExtension();
  const sm = SessionManager.inMemory("/tmp/x");
  const { ctx, titles } = fakeCtx(sm, []);
  ctx.hasUI = false;
  const result = await forkHandler({ type: "session_before_fork", entryId: "e", position: "at" }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(titles, []);
});

test("hook: escape cancels the fork", async () => {
  const { forkHandler } = loadExtension();
  const sm = SessionManager.inMemory("/tmp/x");
  const { ctx, notices } = fakeCtx(sm, [undefined]);
  const result = await forkHandler({ type: "session_before_fork", entryId: "e", position: "at" }, ctx);
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(notices, ["Fork cancelled."]);
});

test("hook: fork here in the current directory defers to the native fork", async () => {
  const { forkHandler } = loadExtension();
  const root = mkdtempSync(join(tmpdir(), "heist-root-"));
  try {
    const sm = SessionManager.inMemory(root);
    const { ctx, titles, notices } = fakeCtx(sm, ["[ fork here ]"]);
    const result = await forkHandler({ type: "session_before_fork", entryId: "e", position: "at" }, ctx);
    assert.equal(result, undefined);
    assert.deepEqual(titles, [`Fork into: ${root}`]);
    assert.deepEqual(notices, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flow: browse into a subdirectory, then /heist writes the branch there and switches", async () => {
  const { forkHandler, heist } = loadExtension();
  const root = mkdtempSync(join(tmpdir(), "heist-root-"));
  const target = join(root, "other");
  mkdirSync(target);
  try {
    const { sm, first, second } = sourceSession(root);
    const { ctx, notices, titles, switched } = fakeCtx(sm, ["other/", "[ fork here ]"]);

    const result = await forkHandler({ type: "session_before_fork", entryId: second, position: "before" }, ctx);
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(titles, [`Fork into: ${root}`, `Fork into: ${target}`]);
    assert.deepEqual(notices, [`Target: ${target}. Run /heist to fork there.`]);

    await heist("", ctx);
    assert.equal(switched.length, 1);
    assert.deepEqual(notices.slice(1), []);
    assert.equal(switched[0]!.editorText, "second");
    assert.deepEqual(switched[0]!.notices, [`Forked into ${target}`]);

    // Default store: pi's own encoding under <agentDir>/sessions.
    assert.equal(targetSessionDir(sm), undefined);
    assert.equal(switched[0]!.path, SessionManager.open(switched[0]!.path).getSessionFile());
    assert.ok(switched[0]!.path.startsWith(join(agentDir, "sessions") + sep));
    assert.ok(!switched[0]!.path.startsWith(sm.getSessionDir()));

    // Header carries the target cwd and the parent session; entries are the branch before "second".
    const lines = readFileSync(switched[0]!.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].cwd, target);
    assert.equal(lines[0].parentSession, sm.getSessionFile());
    assert.deepEqual(lines.slice(1).map((e) => e.id), [first]);

    // Nothing was written inside the target directory, and the source is untouched.
    assert.deepEqual(readdirSync(target), []);
    assert.equal(sm.getEntries().length, 2);

    // The pending target was consumed.
    await heist("", ctx);
    assert.equal(notices.at(-1), "No fork pending. Fork to a different directory first.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flow: a custom --session-dir keeps the new session in that directory", async () => {
  const { forkHandler, heist } = loadExtension();
  const root = mkdtempSync(join(tmpdir(), "heist-root-"));
  const target = join(root, "other");
  const sessionDir = join(root, "sessions");
  mkdirSync(target);
  try {
    const { sm, second } = sourceSession(root, sessionDir);
    const { ctx, switched } = fakeCtx(sm, ["other/", "[ fork here ]"]);
    await forkHandler({ type: "session_before_fork", entryId: second, position: "at" }, ctx);
    await heist("", ctx);
    assert.equal(targetSessionDir(sm), sessionDir);
    assert.equal(dirname(switched[0]!.path), sessionDir);
    assert.equal(switched[0]!.editorText, undefined);
    const lines = readFileSync(switched[0]!.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/heist: a target set in another session is discarded", async () => {
  const { forkHandler, heist } = loadExtension();
  const root = mkdtempSync(join(tmpdir(), "heist-root-"));
  mkdirSync(join(root, "other"));
  try {
    const { sm, second } = sourceSession(root);
    const { ctx } = fakeCtx(sm, ["other/", "[ fork here ]"]);
    await forkHandler({ type: "session_before_fork", entryId: second, position: "at" }, ctx);

    const other = fakeCtx(SessionManager.inMemory(root), []);
    await heist("", other.ctx);
    assert.deepEqual(other.notices, ["Pending fork belongs to a different session. Discarded."]);
    assert.equal(other.switched.length, 0);
    await heist("", ctx);
    assert.equal(ctx.sessionManager, sm);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/heist: a target removed after it was chosen fails without creating it", async () => {
  const { forkHandler, heist } = loadExtension();
  const root = mkdtempSync(join(tmpdir(), "heist-root-"));
  const target = join(root, "other");
  mkdirSync(target);
  try {
    const { sm, second } = sourceSession(root);
    const { ctx, notices, switched } = fakeCtx(sm, ["other/", "[ fork here ]"]);
    await forkHandler({ type: "session_before_fork", entryId: second, position: "at" }, ctx);
    rmSync(target, { recursive: true });
    await heist("", ctx);
    assert.equal(switched.length, 0);
    assert.equal(notices.at(-1), `Fork failed: Target directory no longer exists: ${target}`);
    assert.ok(!existsSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
