import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// The T.V.A. patrols the sacred timeline of session trees. Here it patrols the
// sacred timeline of *versions*: latest stable. A pinned version behind the
// current major is a variant, and this sentinel intercepts it before it reaches
// disk -- because a version recalled from an agent's training data is suspect.
//
// Scope (deliberately narrow): only the text being written this edit is checked
// (the write payload), never the file on disk or the wider project. Only
// major-behind is flagged (minor/patch is Dependabot's lane). Block once with a
// reason; a deliberate re-issue passes. Fail-open everywhere.

export type Ecosystem = "npm" | "pypi" | "cargo" | "go" | "rubygems" | "gha";

export interface Pin {
  name: string;
  spec: string;
}

const UA = "pi-version-sentinel";
const FETCH_TIMEOUT_MS = 1500;
const MAX_WARNED = 500;

// package.json keys that are metadata, not dependencies. Without this the
// package's own `"version": "0.1.0"` would be looked up as the npm package
// `version` (which exists) and wrongly flagged.
const NPM_META_KEYS = new Set([
  "version", "name", "description", "main", "module", "types", "typings",
  "license", "author", "homepage", "repository", "bugs", "keywords", "type",
  "private", "engines", "packagemanager", "scripts", "bin", "files", "exports",
  "directory", "url", "funding", "workspaces", "sideeffects", "browser",
  "unpkg", "jsdelivr", "publishconfig",
]);

const DEP_SECTIONS = [
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
];

// --- detection -------------------------------------------------------------

export function detectEcosystem(path: string): Ecosystem | null {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (base === "package.json") return "npm";
  if (base === "pyproject.toml") return "pypi";
  if (base === "cargo.toml") return "cargo";
  if (base === "go.mod") return "go";
  if (base === "gemfile") return "rubygems";
  if (/^requirements[\w.-]*\.txt$/.test(base)) return "pypi";
  if ((base.endsWith(".yml") || base.endsWith(".yaml")) && norm.includes("/.github/workflows/")) {
    return "gha";
  }
  return null;
}

// --- version specs ---------------------------------------------------------

/** Specs we never check: floating ranges, tags, urls, paths, aliases, shas. */
export function isFloating(spec: string): boolean {
  const s = spec.trim().toLowerCase();
  if (!s) return true;
  if (["latest", "*", "x", "next", "workspace:*", "catalog:"].includes(s)) return true;
  if (/^(git|file:|https?:|link:|portal:|npm:|workspace:|catalog)/.test(s)) return true;
  if (s.includes("/")) return true;
  if (/^[0-9a-f]{7,40}$/.test(s)) return true;
  return false;
}

export function parseMajor(text: string): number | null {
  const m = /(\d+)(?:\.\d+)?(?:\.\d+)?/.exec(text);
  return m && m[1] !== undefined ? parseInt(m[1], 10) : null;
}

/** Non-null when `spec`'s major is behind `latest`'s major. */
export function isStaleMajor(
  spec: string,
  latest: string | null,
): { behind: number; latest: string } | null {
  if (!latest || isFloating(spec)) return null;
  const sm = parseMajor(spec);
  const lm = parseMajor(latest);
  if (sm === null || lm === null) return null;
  return sm < lm ? { behind: lm - sm, latest } : null;
}

function looksLikeVersionSpec(s: string): boolean {
  const t = s.trim();
  if (!t || isFloating(t)) return false;
  return /^[\^~>=<v]*\d/.test(t);
}

// --- extraction (write payload only) ---------------------------------------

function dedupe(pins: Pin[]): Pin[] {
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const p of pins) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

function extractNpm(text: string): Pin[] {
  const trimmed = text.trim();
  // Whole-file write parses as JSON -> read only the dependency sections. Do not
  // fall through to the fragment regex, which would scan metadata keys.
  if (trimmed.startsWith("{")) {
    try {
      const d = JSON.parse(trimmed) as Record<string, unknown>;
      const out: Pin[] = [];
      for (const sec of DEP_SECTIONS) {
        const deps = d[sec];
        if (deps && typeof deps === "object") {
          for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
            if (typeof spec === "string") out.push({ name, spec });
          }
        }
      }
      return dedupe(out);
    } catch {
      // not valid JSON -> treat as a fragment
    }
  }
  const out: Pin[] = [];
  const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const spec = m[2];
    if (name === undefined || spec === undefined) continue;
    if (NPM_META_KEYS.has(name.toLowerCase())) continue;
    if (!looksLikeVersionSpec(spec)) continue;
    out.push({ name, spec });
  }
  return dedupe(out);
}

function extractPypi(text: string): Pin[] {
  const out: Pin[] = [];
  const req = /(?:^|[\s"'[])([A-Za-z0-9._-]+)\s*(==|~=|>=|<=|>|<)\s*([0-9][^,;"'\s\]]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = req.exec(text)) !== null) {
    if (m[1] && m[2] && m[3]) out.push({ name: m[1], spec: m[2] + m[3] });
  }
  const toml = /^\s*([A-Za-z0-9._-]+)\s*=\s*["']([~^<>=!]*[0-9][^"']*)["']/gm;
  while ((m = toml.exec(text)) !== null) {
    if (m[1] && m[2] && m[1].toLowerCase() !== "python") out.push({ name: m[1], spec: m[2] });
  }
  return dedupe(out);
}

function extractCargo(text: string): Pin[] {
  const out: Pin[] = [];
  const simple = /^\s*([A-Za-z0-9._-]+)\s*=\s*["']([~^<>=]*[0-9][^"']*)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = simple.exec(text)) !== null) {
    if (m[1] && m[2]) out.push({ name: m[1], spec: m[2] });
  }
  const table = /^\s*([A-Za-z0-9._-]+)\s*=\s*\{[^}]*\bversion\s*=\s*["']([~^<>=]*[0-9][^"']*)["']/gm;
  while ((m = table.exec(text)) !== null) {
    if (m[1] && m[2]) out.push({ name: m[1], spec: m[2] });
  }
  return dedupe(out);
}

function extractGo(text: string): Pin[] {
  const out: Pin[] = [];
  for (const line of text.split("\n")) {
    if (line.includes("// indirect") || /^\s*(module|go)\s/.test(line)) continue;
    const m = /([a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)+)\s+(v[0-9][0-9A-Za-z.\-+]*)/.exec(line);
    if (m && m[1] && m[2]) out.push({ name: m[1], spec: m[2] });
  }
  return dedupe(out);
}

function extractRubygems(text: string): Pin[] {
  const out: Pin[] = [];
  const re = /\bgem\s+["']([^"']+)["']\s*,\s*["']([~>=<\s0-9.]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[2]) out.push({ name: m[1], spec: m[2].trim() });
  }
  return dedupe(out);
}

function extractGha(text: string): Pin[] {
  const out: Pin[] = [];
  const re = /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([^\s#'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[2]) out.push({ name: m[1], spec: m[2] });
  }
  return dedupe(out);
}

export function extractPins(eco: Ecosystem, text: string): Pin[] {
  switch (eco) {
    case "npm": return extractNpm(text);
    case "pypi": return extractPypi(text);
    case "cargo": return extractCargo(text);
    case "go": return extractGo(text);
    case "rubygems": return extractRubygems(text);
    case "gha": return extractGha(text);
  }
}

// --- registry --------------------------------------------------------------

export type Transport = (url: string, headers?: Record<string, string>) => Promise<any>;

const defaultTransport: Transport = async (url, headers) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

function npmPath(name: string): string {
  return name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}

/** Latest STABLE version for a package, or null on any failure. */
export async function latestStable(
  eco: Ecosystem,
  name: string,
  transport: Transport = defaultTransport,
): Promise<string | null> {
  try {
    switch (eco) {
      case "npm":
        return (await transport(`https://registry.npmjs.org/${npmPath(name)}/latest`))?.version ?? null;
      case "pypi":
        return (await transport(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`))?.info?.version ?? null;
      case "cargo":
        return (await transport(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`))?.crate?.max_stable_version ?? null;
      case "go": {
        const esc = name.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
        return (await transport(`https://proxy.golang.org/${esc}/@latest`))?.Version ?? null;
      }
      case "rubygems":
        return (await transport(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`))?.version ?? null;
      case "gha":
        return (await transport(`https://api.github.com/repos/${name}/releases/latest`))?.tag_name ?? null;
    }
  } catch {
    return null;
  }
}

// --- reason ----------------------------------------------------------------

interface StalePin extends Pin {
  behind: number;
  latest: string;
}

export function buildReason(stale: StalePin[]): string {
  const lines = stale.map(
    (s) => `  • ${s.name} ${s.spec} → latest stable ${s.latest} (${s.behind} major${s.behind > 1 ? "s" : ""} behind)`,
  );
  return [
    "T.V.A. version sentinel — this write pins a variant that has diverged from the sacred timeline (latest stable):",
    ...lines,
    "A version recalled from training data is suspect. Verify against the registry, then re-issue this write to proceed (it passes the second time).",
  ].join("\n");
}

// --- extension -------------------------------------------------------------

const warned = new Set<string>();

function remember(key: string): void {
  if (warned.size > MAX_WARNED) warned.clear();
  warned.add(key);
}

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, Promise<string | null>>();
  const cachedLatest = (eco: Ecosystem, name: string): Promise<string | null> => {
    const key = `${eco}:${name}`;
    let p = cache.get(key);
    if (p === undefined) {
      p = latestStable(eco, name).catch(() => null);
      cache.set(key, p);
    }
    return p;
  };

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
    let path: string | undefined;
    let text: string | undefined;
    if (isToolCallEventType("edit", event)) {
      // Pi's edit applies an array of edits per call; check every inserted text.
      path = event.input.path;
      text = event.input.edits.map((e) => e.newText).join("\n");
    } else if (isToolCallEventType("write", event)) {
      path = event.input.path;
      text = event.input.content;
    } else {
      return;
    }
    if (!path || !text) return;

    const eco = detectEcosystem(path);
    if (!eco) return;

    let pins: Pin[];
    try {
      pins = extractPins(eco, text);
    } catch {
      return;
    }
    if (pins.length === 0) return;

    const filePath = path;
    const checks = await Promise.all(
      pins.map(async ({ name, spec }): Promise<StalePin | null> => {
        const key = `${filePath}|${name}|${spec}`;
        if (warned.has(key)) return null; // already pushed back on this exact pin -> defer
        const latest = await cachedLatest(eco, name);
        const stale = isStaleMajor(spec, latest);
        return stale ? { name, spec, behind: stale.behind, latest: stale.latest } : null;
      }),
    );

    const stale = checks.filter((c): c is StalePin => c !== null);
    if (stale.length === 0) return;

    for (const s of stale) remember(`${filePath}|${s.name}|${s.spec}`);
    return { block: true, reason: buildReason(stale) };
  });
}
