import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForgottenSet } from "./notes.ts";

/** Register the `context` and `session_before_compact` handlers (and `session_start` cache
 * invalidation). `deps` lets tests inject a fake compaction function. */
export function registerHooks(_pi: ExtensionAPI, _deps?: HookDeps): void {
	throw new Error("not implemented");
}

/** Drop the cached forgotten set; commands call this after writing a note. */
export function invalidate(): void {
	throw new Error("not implemented");
}

/** Forgotten set for the current path, cached on (leafId, number of pi-pluck entries). */
export function forgottenFor(_ctx: ExtensionContext): ForgottenSet {
	throw new Error("not implemented");
}

export type HookDeps = {
	/** Defaults to pi's exported `compact`. */
	compact?: typeof import("@earendil-works/pi-coding-agent").compact;
};
