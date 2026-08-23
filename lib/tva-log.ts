import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import path from "node:path";

// One debug log for the whole toolbox. Every writer tags its lines, so the
// shared file stays attributable.
export const LOG_FILE = path.join(getAgentDir(), "tva.log");

export function createLogger(tag: string): (message: string) => void {
  return (message) => {
    try {
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${message}\n`);
    } catch (error) {
      // Report rather than swallow, but never let a bad log path kill the caller.
      process.stderr.write(`tva: cannot write ${LOG_FILE}: ${error}\n`);
    }
  };
}
