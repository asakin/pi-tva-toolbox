import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectEcosystem,
  isFloating,
  parseMajor,
  isStaleMajor,
  extractPins,
  latestStable,
  type Transport,
} from "./index.ts";

// --- detection -------------------------------------------------------------

test("detectEcosystem maps manifests, ignores everything else", () => {
  assert.equal(detectEcosystem("/r/package.json"), "npm");
  assert.equal(detectEcosystem("/r/pyproject.toml"), "pypi");
  assert.equal(detectEcosystem("/r/requirements.txt"), "pypi");
  assert.equal(detectEcosystem("/r/requirements-dev.txt"), "pypi");
  assert.equal(detectEcosystem("/r/Cargo.toml"), "cargo");
  assert.equal(detectEcosystem("/r/go.mod"), "go");
  assert.equal(detectEcosystem("/r/Gemfile"), "rubygems");
  assert.equal(detectEcosystem("/r/.github/workflows/ci.yml"), "gha");
  assert.equal(detectEcosystem("/r/src/index.ts"), null);
  assert.equal(detectEcosystem("/r/README.md"), null);
  // a yaml NOT under .github/workflows is not a GHA manifest
  assert.equal(detectEcosystem("/r/config.yml"), null);
});

// --- version specs ---------------------------------------------------------

test("isFloating skips ranges/tags/urls/paths/shas, not real pins", () => {
  for (const s of ["latest", "*", "workspace:*", "git+https://x", "file:../x", "npm:a@1", "a1b2c3d4e5f6", "org/pkg"]) {
    assert.equal(isFloating(s), true, s);
  }
  for (const s of ["^5.0.0", "7.0.2", "~1.2.3", "v4", ">=1.0.0"]) {
    assert.equal(isFloating(s), false, s);
  }
});

test("parseMajor pulls the leading major", () => {
  assert.equal(parseMajor("^5.0.0"), 5);
  assert.equal(parseMajor("7.0.2"), 7);
  assert.equal(parseMajor("v4"), 4);
  assert.equal(parseMajor("no digits"), null);
});

test("isStaleMajor fires only when behind a major", () => {
  assert.deepEqual(isStaleMajor("^5.0.0", "7.0.2"), { behind: 2, latest: "7.0.2" });
  assert.equal(isStaleMajor("^7.0.0", "7.0.2"), null); // same major
  assert.equal(isStaleMajor("7.0.2", "7.0.2"), null); // current
  assert.equal(isStaleMajor("latest", "7.0.2"), null); // floating
  assert.equal(isStaleMajor("^5.0.0", null), null); // no registry answer
});

// --- extraction (write payload only) ---------------------------------------

test("npm whole-file: dependency sections only, never metadata", () => {
  const pkg = JSON.stringify({
    name: "my-pkg",
    version: "0.1.0",
    dependencies: { lodash: "^3.0.0" },
    devDependencies: { typescript: "^5.0.0" },
  });
  const pins = extractPins("npm", pkg);
  assert.deepEqual(
    pins.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "lodash", spec: "^3.0.0" }, { name: "typescript", spec: "^5.0.0" }],
  );
});

test("npm fragment: the package's own version field is not treated as a dep", () => {
  assert.deepEqual(extractPins("npm", '"typescript": "^5.0.0"'), [{ name: "typescript", spec: "^5.0.0" }]);
  assert.deepEqual(extractPins("npm", '"version": "0.1.0"'), []); // the classic false positive
  assert.deepEqual(extractPins("npm", '"name": "foo"'), []);
});

test("github actions: uses: owner/repo@ref", () => {
  assert.deepEqual(
    extractPins("gha", "      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v7"),
    [{ name: "actions/checkout", spec: "v4" }, { name: "actions/setup-node", spec: "v7" }],
  );
});

// --- registry (mocked transport, no network) -------------------------------

const mock = (payload: unknown): Transport => async () => payload;

test("latestStable reads the right field per registry", async () => {
  assert.equal(await latestStable("npm", "typescript", mock({ version: "7.0.2" })), "7.0.2");
  assert.equal(await latestStable("pypi", "requests", mock({ info: { version: "2.32.0" } })), "2.32.0");
  assert.equal(await latestStable("cargo", "serde", mock({ crate: { max_stable_version: "1.0.229" } })), "1.0.229");
  assert.equal(await latestStable("go", "x/y", mock({ Version: "v1.2.3" })), "v1.2.3");
  assert.equal(await latestStable("rubygems", "rails", mock({ version: "7.1.0" })), "7.1.0");
  assert.equal(await latestStable("gha", "actions/checkout", mock({ tag_name: "v7.0.1" })), "v7.0.1");
});

test("latestStable fails open (null) when the transport throws", async () => {
  const boom: Transport = async () => {
    throw new Error("network down");
  };
  assert.equal(await latestStable("npm", "typescript", boom), null);
});

test("latestStable encodes scoped npm names as @scope%2Fpkg", async () => {
  let seen = "";
  const spy: Transport = async (url) => {
    seen = url;
    return { version: "1.0.0" };
  };
  await latestStable("npm", "@arielsakin/pi-time-heist", spy);
  assert.ok(seen.includes("@arielsakin%2Fpi-time-heist"), seen);
});
