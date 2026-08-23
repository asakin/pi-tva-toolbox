// The umbrella tarball is the one artifact that cannot be typechecked: its
// pi.extensions paths point into bundled node_modules, and a wrong files glob
// or a bundling miss ships a package that loads nothing. Pack it for real and
// look inside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function packedEntries(dir) {
  const out = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const { filename } = JSON.parse(out)[0];
  return execFileSync("tar", ["tzf", join(dir, filename)], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ""));
}

test("umbrella tarball carries every pi.extensions entry, bundled for real", () => {
  const dir = mkdtempSync(join(tmpdir(), "tva-pack-"));
  try {
    const entries = new Set(packedEntries(dir));
    for (const ext of pkg.pi.extensions) {
      assert.ok(entries.has(ext), `missing from tarball: ${ext}`);
    }
    for (const name of pkg.bundleDependencies) {
      assert.ok(entries.has(`node_modules/${name}/package.json`), `not bundled: ${name}`);
    }
    // Children's runtime deps ride along (lib), tests do not.
    assert.ok(entries.has("node_modules/@arielsakin/pi-tva-lib/package.json"), "lib not bundled transitively");
    assert.equal([...entries].filter((e) => e.endsWith(".test.ts")).length, 0, "test files leaked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
