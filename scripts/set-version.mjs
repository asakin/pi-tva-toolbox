// Lockstep version bump for the whole toolbox: root umbrella, lib, and every
// extension move together, and every internal dependency (root → extensions,
// extension → lib) is re-pinned to the new exact version. npm version alone
// does not rewrite dependency specs, which is the part that matters here.
//
//   npm run version:set 0.2.0
//
// Then review the diff, commit, tag vX.Y.Z, publish a GitHub release.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");

const rootPkg = read(join(root, "package.json"));
const workspaceDirs = rootPkg.workspaces.flatMap((pattern) => globSync(pattern, { cwd: root }));
const manifests = [join(root, "package.json"), ...workspaceDirs.map((d) => join(root, d, "package.json"))];
const internal = new Set(manifests.map((p) => read(p).name));

for (const p of manifests) {
  const pkg = read(p);
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (internal.has(name) && field !== "peerDependencies") pkg[field][name] = version;
    }
  }
  write(p, pkg);
  console.log(`${pkg.name} → ${version}`);
}

// Refresh the lockfile's workspace entries without touching node_modules.
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
