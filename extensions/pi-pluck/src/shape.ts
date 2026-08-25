import type { AgentMessage, ForgottenSet } from "./notes.ts";

/** The only place turns are removed. Splits `messages` into turns on `role === "user"` and drops
 * a whole turn when its user message's timestamp is in `forgotten`. Order preserved; a leading
 * run of non-user messages is never dropped. Never edits a message. */
export function shape(_messages: AgentMessage[], _forgotten: ForgottenSet): AgentMessage[] {
	throw new Error("not implemented");
}
