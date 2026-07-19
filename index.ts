import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // The TVA is watching.
  pi.on("session_start", async (_event, ctx) => {
    // This hook runs at the start of a session, but right now it just quietly observes.
  });

  // A basic command to test if the extension is loaded correctly.
  pi.registerCommand("tva-status", {
    description: "Check the status of the Sacred Timeline",
    handler: async (args, ctx) => {
      ctx.ui.notify("The Sacred Timeline is secure.", "info");
    },
  });
}
