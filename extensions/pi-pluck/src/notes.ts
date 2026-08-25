import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

/** A message as pi hands it to the `context` hook (pi-agent-core's AgentMessage, reached
 * through the coding-agent's exported event type because pi-agent-core is not a direct dep). */
export type AgentMessage = ContextEvent["messages"][number];

export const PLUCK_CUSTOM_TYPE = "pi-pluck";

/** One forgotten turn, keyed on its user message's millisecond timestamp (what `shape()` matches
 * on — AgentMessage carries no entry id); entryId is for listings only. */
export type ForgottenTurn = { ts: number; entryId: string };

export type OverlayNote = {
	kind: "overlay";
	regexStr: string;
	labelText: string;
	forgotten: ForgottenTurn[];
};
export type CancelNote = { kind: "cancel"; noteIds: string[] };
/** Written by the retired clone-based pluck. Recognised so old sessions load; never shapes. */
export type LegacyNote = { kind: "trunk-anchor"; [k: string]: unknown };
export type PluckNote = OverlayNote | CancelNote | LegacyNote;

/** User-message timestamps (ms) of every turn currently forgotten on a path. */
export type ForgottenSet = ReadonlySet<number>;

/** Fold every `pi-pluck` custom entry on a path, in path order: overlay adds its turns, cancel
 * removes exactly the turns of the notes it names, anything else is ignored. */
export function collectForgotten(entries: readonly SessionEntry[]): ForgottenSet {
	// Multiset, not set: a turn forgotten by two overlays stays forgotten when only one is
	// cancelled, so each ts counts how many live overlays still name it.
	const counts = new Map<number, number>();
	const byNote = new Map<string, number[]>();
	for (const entry of entries) {
		if (!isPluckEntry(entry)) continue;
		const note = entry.data;
		if (isOverlay(note)) {
			const ts = note.forgotten.map((f) => f.ts);
			byNote.set(entry.id, ts);
			for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
		} else if (isCancel(note)) {
			for (const id of note.noteIds) {
				const ts = byNote.get(id);
				if (!ts) continue;
				// A note cancelled twice must not go negative: forget it once, then drop it.
				byNote.delete(id);
				for (const t of ts) {
					const n = (counts.get(t) ?? 0) - 1;
					if (n <= 0) counts.delete(t);
					else counts.set(t, n);
				}
			}
		}
	}
	return new Set(counts.keys());
}

/** Overlay notes on a path with their entry ids, for /unpluck. */
export function listOverlayNotes(
	entries: readonly SessionEntry[],
): Array<{ id: string; note: OverlayNote; cancelled: boolean }> {
	const overlays: Array<{ id: string; note: OverlayNote; cancelled: boolean }> = [];
	for (const entry of entries) {
		if (!isPluckEntry(entry)) continue;
		const note = entry.data;
		if (isOverlay(note)) {
			overlays.push({ id: entry.id, note, cancelled: false });
		} else if (isCancel(note)) {
			// Only earlier overlays exist in the list, so "later cancel" is path order for free.
			for (const o of overlays) if (note.noteIds.includes(o.id)) o.cancelled = true;
		}
	}
	return overlays;
}

type PluckEntry = Extract<SessionEntry, { type: "custom" }> & { data: unknown };

function isPluckEntry(entry: SessionEntry): entry is PluckEntry {
	return entry.type === "custom" && entry.customType === PLUCK_CUSTOM_TYPE;
}

// Notes come off disk from any past version of this extension, so shape-check rather than trust.
function isOverlay(data: unknown): data is OverlayNote {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return (
		d.kind === "overlay" &&
		Array.isArray(d.forgotten) &&
		d.forgotten.every(
			(f) => typeof f === "object" && f !== null && typeof (f as { ts?: unknown }).ts === "number",
		)
	);
}

function isCancel(data: unknown): data is CancelNote {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return d.kind === "cancel" && Array.isArray(d.noteIds) && d.noteIds.every((n) => typeof n === "string");
}
