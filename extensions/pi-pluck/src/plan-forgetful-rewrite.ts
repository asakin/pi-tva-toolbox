import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Turn } from "./pluck-steps.ts";

export type PluckPlan =
	| {
			ok: false;
			reason: "no_match" | "not_useful" | "catches_all";
			regexStr: string;
	  }
	| {
			ok: true;
			regexStr: string;
			keptTurns: Turn[];
			skippedCount: number;
			originalTurnCount: number;
			keptTurnCount: number;
			/** True when the first user turn matched and the whole session-head turn was kept. */
			rootProtected: boolean;
			/**
			 * Last shared kept ancestor id on the original path.
			 * Bookkeeping only — grow clones the full kept chain as a parallel root/sibling;
			 * it does not hang new nodes from this id.
			 */
			divergenceParentId: string;
			/**
			 * One short line per forgotten turn (for confirm UI).
			 * Whole turns only — never a half-forgotten head assistant side.
			 */
			forgottenPreviews: string[];
	  };

const PREVIEW_MAX_CHARS = 72;

function truncatePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= PREVIEW_MAX_CHARS) return oneLine;
	return `${oneLine.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}

/** Prefer user text; else first searchable entry text. */
function turnPreview(turn: Turn): string {
	for (const entry of turn) {
		if (entry.type === "message" && entry.message.role === "user") {
			const text = contentToText(entry.message.content);
			if (text) return truncatePreview(text);
		}
	}
	for (const entry of turn) {
		const text = entryMatchText(entry);
		if (text) return truncatePreview(text);
	}
	return "(no text)";
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/**
 * Text we are allowed to match against for one entry.
 * User text, assistant text, tool name + args — never tool result payloads.
 */
function entryMatchText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const msg = entry.message;
	// Trap: tool *results* must never match — only user/assistant text and toolCall name+args.
	if (msg.role === "toolResult") return "";
	if (msg.role === "user") return contentToText(msg.content);
	if (msg.role === "assistant") {
		const parts: string[] = [];
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as {
				type?: string;
				text?: string;
				name?: string;
				arguments?: unknown;
			};
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			if (b.type === "toolCall") {
				if (typeof b.name === "string") parts.push(b.name);
				try {
					parts.push(JSON.stringify(b.arguments ?? {}));
				} catch {
					parts.push(String(b.arguments));
				}
			}
		}
		return parts.join("\n");
	}
	return "";
}

/** A turn matches if any searchable entry in it matches the regex. */
function turnMatches(turn: Turn, regex: RegExp): boolean {
	for (const entry of turn) {
		const text = entryMatchText(entry);
		// Require non-empty text so patterns like /.*/ don't match blank/preamble-only entries.
		if (text && regex.test(text)) return true;
	}
	return false;
}

/** Id of the very first user message on the path — the session head we never drop. */
function findFirstUserId(turns: Turn[]): string | null {
	for (const turn of turns) {
		for (const entry of turn) {
			if (entry.type === "message" && entry.message.role === "user") {
				return entry.id;
			}
		}
	}
	return null;
}

/**
 * Decide what a forgetful rewrite would look like — pure planning, no session writes.
 *
 * - Keep turns that do not match; omit turns that do (whole turns only).
 * - If the first user turn matches, keep that entire turn (rootProtected) and forget
 *   only later matching turns. The overlay cannot drop half a turn, and dropping the
 *   session head would rewrite shared history or force a multi-root tree.
 * - Grow clones the full kept chain in parallel. divergenceParentId records the last
 *   shared kept ancestor on the original path (bookkeeping / debugging only).
 * - If the shared prefix with the original path is empty, the plan is not useful.
 * - If only the head matched, nothing is forgotten → not_useful.
 */
export function planForgetfulRewrite(
	turns: Turn[],
	regex: RegExp,
	regexStr: string,
): PluckPlan {
	const path = turns.flat();
	const firstUserId = findFirstUserId(turns);

	const keptTurns: Turn[] = [];
	const forgottenPreviews: string[] = [];
	let skippedCount = 0;
	let rootProtected = false;

	for (const turn of turns) {
		if (!turnMatches(turn, regex)) {
			keptTurns.push(turn);
			continue;
		}

		const userIdx = firstUserId
			? turn.findIndex((entry) => entry.id === firstUserId)
			: -1;

		// Session head must stay as a whole turn: the overlay is turn-granular, and
		// dropping the head rewrites every other branch's history or forces a
		// multi-root tree. Do not count it as forgotten.
		if (userIdx >= 0 && !rootProtected) {
			rootProtected = true;
			keptTurns.push(turn);
			continue;
		}

		skippedCount++;
		forgottenPreviews.push(turnPreview(turn));
	}

	// .* / blanket patterns: every turn matched. Even with root-protect, that is a
	// wipe of the conversation path — refuse instead of building a label-only stub.
	if (skippedCount === turns.length) {
		return { ok: false, reason: "catches_all", regexStr };
	}

	// Preamble (model_change, etc.) often has no matchable text, so it never
	// "matches" — but if every user-led turn matched, the conversation is wiped
	// (rootProtected would keep only the head turn). Refuse as catch-all.
	// Checked before the skippedCount===0 exit so a sole matching head is
	// catches_all, not not_useful.
	const userTurns = turns.filter((turn) =>
		turn.some(
			(entry) =>
				entry.type === "message" && entry.message.role === "user",
		),
	);
	if (
		userTurns.length > 0 &&
		userTurns.every((turn) => turnMatches(turn, regex))
	) {
		return { ok: false, reason: "catches_all", regexStr };
	}

	if (skippedCount === 0) {
		// Head may have matched, but nothing was actually forgotten.
		if (rootProtected) {
			return { ok: false, reason: "not_useful", regexStr };
		}
		return { ok: false, reason: "no_match", regexStr };
	}

	// Shared prefix with the original path — recorded as divergenceParentId for
	// bookkeeping. Grow still clones the entire kept chain in parallel.
	const keptFlat = keptTurns.flat();
	let sharedLen = 0;
	while (
		sharedLen < keptFlat.length &&
		sharedLen < path.length &&
		keptFlat[sharedLen]!.id === path[sharedLen]!.id
	) {
		sharedLen++;
	}

	// e.g. matching preamble-only before any user — nowhere legal to hang.
	if (sharedLen === 0) {
		return { ok: false, reason: "not_useful", regexStr };
	}

	const divergenceParentId = path[sharedLen - 1]!.id;

	// "Keeps N" in confirm copy means turns after the protected head, not including it.
	let keptTurnCount = keptTurns.length;
	if (rootProtected) keptTurnCount = Math.max(0, keptTurnCount - 1);

	return {
		ok: true,
		regexStr,
		keptTurns,
		skippedCount,
		originalTurnCount: turns.length,
		keptTurnCount,
		rootProtected,
		divergenceParentId,
		forgottenPreviews,
	};
}
