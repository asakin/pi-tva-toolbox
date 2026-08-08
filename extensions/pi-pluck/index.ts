import type { ExtensionAPI, SessionEntry, SessionMessageEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import crypto from "node:crypto";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pluck", {
		description: "Non-destructively regenerate the current branch, omitting turns that match a regex",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
            const regexStr = args.trim();
            if (!regexStr) {
                ctx.ui.notify("Usage: /pluck <regex>", "error");
                return;
            }
            
            let regex: RegExp;
            try {
                regex = new RegExp(regexStr, "i");
            } catch (e: any) {
                ctx.ui.notify(`Invalid regex: ${e.message}`, "error");
                return;
            }

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("pluck: this session has no entries yet.", "info");
				return;
			}

			// Step 1: Chunk the flat timeline into semantic "Turns".
            // A turn represents a complete interaction cycle: User Prompt -> [Agent Reasoning -> Tool Calls -> Tool Results] -> Final Answer.
            // By chunking, we ensure that if a regex catches a bad hallucination mid-flight, we excise the entire cycle 
            // rather than leaving orphaned tool results or dangling prompts in the timeline.
            const path = ctx.sessionManager.getBranch();
            const turns: SessionEntry[][] = [];
            let currentTurn: SessionEntry[] = [];

            for (const entry of path) {
                if (entry.type === "message" && entry.message.role === "user") {
                    if (currentTurn.length > 0) {
                        turns.push(currentTurn);
                    }
                    currentTurn = [];
                }
                currentTurn.push(entry);
            }
            if (currentTurn.length > 0) {
                turns.push(currentTurn);
            }

            // Step 2: Evaluate each turn against the regex.
            // We deliberately skip 'toolResult' entries during the match phase. Tool outputs (like massive bash logs
            // or full file reads) contain unpredictable text. We only want to pluck based on the agent's actual 
            // intentional outputs (what it said, or what commands it chose to run) or the user's prompt.
            const keptTurns: SessionEntry[][] = [];
            let skippedCount = 0;

            for (const turn of turns) {
                let match = false;
                for (const entry of turn) {
                    // Skip massive raw tool outputs to prevent false positives
                    if (entry.type === "message" && entry.message.role === "toolResult") {
                        continue;
                    }
                    
                    const text = JSON.stringify(entry);
                    if (regex.test(text)) {
                        match = true;
                        break;
                    }
                }
                
                if (match) {
                    skippedCount++;
                } else {
                    keptTurns.push(turn);
                }
            }

            if (skippedCount === 0) {
                ctx.ui.notify(`No turns matched regex /${regexStr}/. Nothing to pluck.`, "info");
                return;
            }

            // Step 3: Find the divergence point.
            // To be non-destructive, we only clone entries *after* the first removed turn. 
            // Everything before the first match stays exactly as it was, preserving the original tree structure.
            let divergenceIndex = 0;
            while (divergenceIndex < keptTurns.length && keptTurns[divergenceIndex] === turns[divergenceIndex]) {
                divergenceIndex++;
            }

            const prefixTurns = keptTurns.slice(0, divergenceIndex);
            
            // The parent for our first newly cloned entry must be the last entry of the last turn we kept.
            let currentParentId: string | null = null;
            if (prefixTurns.length > 0) {
                const lastTurn = prefixTurns[prefixTurns.length - 1];
                if (lastTurn && lastTurn.length > 0) {
                    const lastEntry = lastTurn[lastTurn.length - 1];
                    if (lastEntry) {
                        currentParentId = lastEntry.id;
                    }
                }
            }

            const newEntries: SessionEntry[] = [];
            
            // Step 4: Re-weave the timeline.
            // We clone the surviving turns and generate fresh cryptographically secure IDs, 
            // stitching them together sequentially from the divergence point.
            for (let i = divergenceIndex; i < keptTurns.length; i++) {
                const turn = keptTurns[i];
                if (!turn) continue;
                for (const entry of turn) {
                    // clone entry
                    const newEntry = JSON.parse(JSON.stringify(entry)) as SessionEntry;
                    newEntry.id = crypto.randomBytes(4).toString("hex");
                    newEntry.parentId = currentParentId;
                    newEntries.push(newEntry);
                    currentParentId = newEntry.id;
                }
            }

            if (newEntries.length === 0) {
                // All remaining turns were skipped.
                // We just need to branch back to currentParentId.
                if (currentParentId) {
                    await ctx.navigateTree(currentParentId, { summarize: false });
                    ctx.ui.notify(`Plucked ${skippedCount} turns. Reverted to previous state.`, "info");
                } else {
                    // Root was plucked and nothing remains
                    ctx.ui.notify(`All turns were plucked, including root. Cannot navigate to null.`, "warning");
                }
                return;
            }

            // Step 5: Mark the new branch.
            // We drop a label directly onto the new leaf node so the user can visually identify 
            // the pruned timeline when looking at the /tree view.
            const newLeafId = currentParentId!;
            const timeStr = new Date().toTimeString().slice(0, 5);
            const labelEntry: SessionEntry = {
                type: "label",
                id: crypto.randomBytes(4).toString("hex"),
                parentId: newLeafId,
                timestamp: new Date().toISOString(),
                targetId: newLeafId,
                label: `⚠️ plucked branch ${timeStr}`
            };
            newEntries.push(labelEntry);

            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify("Cannot pluck: No active session file.", "error");
                return;
            }

            // Step 6: Commit the branch to disk.
            // We append the new nodes to the existing JSONL. Because they form a new parent-child chain 
            // branching off the original timeline, they non-destructively create a new path.
            try {
                const lines = newEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
                appendFileSync(sessionFile, lines, "utf8");

                // Switch to the newly extended file so Pi picks up the new leaf
                const result = await ctx.switchSession(sessionFile);
                if (!result.cancelled) {
                    ctx.ui.notify(`Plucked ${skippedCount} turns to form a new branch!`, "info");
                }
            } catch (err: any) {
                ctx.ui.notify(`Failed to append to session file: ${err.message}`, "error");
            }
		},
	});
}
