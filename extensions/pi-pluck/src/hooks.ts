import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compact as piCompact } from "@earendil-works/pi-coding-agent";
import { collectForgotten as collectForgottenImpl, PLUCK_CUSTOM_TYPE } from "./notes.ts";
import type { ForgottenSet } from "./notes.ts";
import { shape as shapeImpl } from "./shape.ts";

export type HookDeps = {
	/** Defaults to pi's exported `compact`. */
	compact?: typeof import("@earendil-works/pi-coding-agent").compact;
	/** Defaults to `shape` from ./shape.ts. */
	shape?: typeof shapeImpl;
	/** Defaults to `collectForgotten` from ./notes.ts. */
	collectForgotten?: typeof collectForgottenImpl;
};

type Cache = { leafId: string | null; noteCount: number; set: ForgottenSet };

/** One session per process, so a module-level cache is enough. */
let cache: Cache | undefined;
/** Module-level so `forgottenFor(ctx)` (called by commands, not only hooks) sees injected deps. */
let collect: typeof collectForgottenImpl = collectForgottenImpl;

const EMPTY: ForgottenSet = new Set<number>();

/** Mirrors pi's own normalisation before `compact`: a `null` header value means "delete". */
function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) if (v !== null) out[k] = v;
	return out;
}

function countNotes(entries: readonly SessionEntry[]): number {
	let n = 0;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === PLUCK_CUSTOM_TYPE) n++;
	}
	return n;
}

/** Register the `context` and `session_before_compact` handlers (and `session_start` cache
 * invalidation). `deps` lets tests inject a fake compaction function. */
export function registerHooks(pi: ExtensionAPI, deps?: HookDeps): void {
	const compact = deps?.compact ?? piCompact;
	const shape = deps?.shape ?? shapeImpl;
	if (deps?.collectForgotten) collect = deps.collectForgotten;

	pi.on("context", (event, ctx) => {
		const set = forgottenFor(ctx);
		if (set.size === 0) return undefined;
		return { messages: shape(event.messages, set) };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const set = forgottenFor(ctx);
			if (set.size === 0 || !ctx.model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) return undefined;
			const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
			const p = event.preparation;
			const shaped = {
				...p,
				messagesToSummarize: shape(p.messagesToSummarize, set),
				turnPrefixMessages: shape(p.turnPrefixMessages, set),
			};
			const result = await compact(
				shaped,
				model,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				event.customInstructions,
				event.signal,
				ctx.thinkingLevel,
				undefined,
				auth.env,
			);
			return { compaction: result };
		} catch (error) {
			// Never throw from a hook: pi compacts unshaped, and the user is told.
			const message = error instanceof Error ? error.message : String(error);
			const text = `pluck: shaped compaction failed (${message}); pi is compacting with the forgotten turns included.`;
			console.error(text);
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			return undefined;
		}
	});

	pi.on("session_start", () => {
		invalidate();
	});
}

/** Drop the cached forgotten set; commands call this after writing a note. */
export function invalidate(): void {
	cache = undefined;
}

/** Forgotten set for the current path, cached on (leafId, number of pi-pluck entries). */
export function forgottenFor(ctx: ExtensionContext): ForgottenSet {
	const sm = ctx.sessionManager;
	const leafId = sm.getLeafId();
	const branch = sm.getBranch();
	const noteCount = countNotes(branch);
	if (cache && cache.leafId === leafId && cache.noteCount === noteCount) return cache.set;
	const set = noteCount === 0 ? EMPTY : collect(branch);
	cache = { leafId, noteCount, set };
	return set;
}
