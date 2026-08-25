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
			/** True when the first user turn matched and was kept whole anyway. */
			rootProtected: boolean;
			/** One short line per forgotten turn, for the confirm dialog. */
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
	// Tool results never match; only user/assistant text and tool-call name + args do.
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

/** Id of the first user message on the path; its turn is never forgotten. */
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
 * Decide which turns the overlay forgets. Pure; no session writes.
 *
 * - Turns that match are forgotten whole; turns that do not are kept.
 * - The first user turn is always kept (rootProtected), so the model still sees the
 *   opening prompt; only later matching turns are forgotten.
 * - Refuses when every turn (or every user turn) matches, when nothing would be
 *   forgotten, or when the first turn would be forgotten.
 */
export function planForgetfulRewrite(
	turns: Turn[],
	regex: RegExp,
	regexStr: string,
): PluckPlan {
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

		// The first user turn is kept whole and not counted as forgotten.
		if (userIdx >= 0 && !rootProtected) {
			rootProtected = true;
			keptTurns.push(turn);
			continue;
		}

		skippedCount++;
		forgottenPreviews.push(turnPreview(turn));
	}

	// Every turn matched: refuse rather than forget the whole conversation.
	if (skippedCount === turns.length) {
		return { ok: false, reason: "catches_all", regexStr };
	}

	// Preamble turns (model_change, etc.) have no matchable text, so also refuse when
	// every user-led turn matched. Checked before the skippedCount === 0 exit so a
	// sole matching head is catches_all, not not_useful.
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
		if (rootProtected) {
			return { ok: false, reason: "not_useful", regexStr };
		}
		return { ok: false, reason: "no_match", regexStr };
	}

	// The first turn must survive; otherwise there is nothing sensible to keep.
	if (keptTurns[0] !== turns[0]) {
		return { ok: false, reason: "not_useful", regexStr };
	}

	// "Keeps N" in the confirm copy counts turns after the protected head.
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
		forgottenPreviews,
	};
}
