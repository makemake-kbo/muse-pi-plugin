import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMuseProvider, type SubscriptionUsage } from "./provider.ts";

export default function museExtension(pi: ExtensionAPI): void {
  let latest: { usage: SubscriptionUsage; at: number } | undefined;
  let activeSessionId: string | undefined;

  pi.registerProvider(createMuseProvider({
    onUsage: (usage, sessionId) => {
      if (sessionId === activeSessionId) latest = { usage, at: Date.now() };
    },
  }));

  pi.on("session_start", (_event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    latest = undefined;
  });
  pi.on("session_shutdown", () => {
    activeSessionId = undefined;
    latest = undefined;
  });

  pi.registerCommand("muse-usage", {
    description: "Show the last Muse subscription usage event (no network request)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(latest
        ? `Muse subscription usage (${new Date(latest.at).toISOString()}):\n${JSON.stringify(latest.usage, null, 2)}`
        : "No Muse subscription usage event received in this session. Select a muse model and send a prompt first.",
      "info");
    },
  });
}
