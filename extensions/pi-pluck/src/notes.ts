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
export function collectForgotten(_entries: readonly SessionEntry[]): ForgottenSet {
	throw new Error("not implemented");
}

/** Overlay notes on a path with their entry ids, for /unpluck. */
export function listOverlayNotes(
	_entries: readonly SessionEntry[],
): Array<{ id: string; note: OverlayNote; cancelled: boolean }> {
	throw new Error("not implemented");
}
