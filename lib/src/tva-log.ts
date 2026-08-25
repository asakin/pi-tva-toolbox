import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import path from "node:path";

// One debug log for the whole toolbox. Every writer tags its lines, so the
// shared file stays attributable.
export const LOG_FILE = path.join(getAgentDir(), "tva.log");

// Opt-in: the log is written only when PI_TVA_DEBUG=1.
export const DEBUG_ENABLED = process.env.PI_TVA_DEBUG === "1";

export function createLogger(tag: string): (message: string) => void {
  if (!DEBUG_ENABLED) return () => {};
  return (message) => {
    try {
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${message}\n`);
    } catch (error) {
      // A bad log path must not kill the caller.
      process.stderr.write(`tva: cannot write ${LOG_FILE}: ${error}\n`);
    }
  };
}
