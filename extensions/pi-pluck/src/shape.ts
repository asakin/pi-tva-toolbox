import type { AgentMessage, ForgottenSet } from "./notes.ts";

/** The only place turns are removed. Splits `messages` into turns on `role === "user"` and drops
 * a whole turn when its user message's timestamp is in `forgotten`. Order preserved; a leading
 * run of non-user messages is never dropped. Never edits a message. */
export function shape(messages: AgentMessage[], forgotten: ForgottenSet): AgentMessage[] {
	if (forgotten.size === 0) return messages.slice();
	const kept: AgentMessage[] = [];
	// Leading non-user messages belong to no turn, so they start as kept.
	let dropping = false;
	for (const m of messages) {
		if (m.role === "user") dropping = forgotten.has(m.timestamp);
		if (!dropping) kept.push(m);
	}
	return kept;
}
