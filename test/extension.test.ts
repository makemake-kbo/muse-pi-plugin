import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import museExtension from "../src/index.ts";

test("extension registers without I/O; usage stays local to the active session", async () => {
  let provider: Provider<"openai-responses"> | undefined;
  const handlers = new Map<string, unknown>();
  let command: { description: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  const api = {
    registerProvider(value: Provider<"openai-responses">) { provider = value; },
    on(event: string, handler: unknown) { handlers.set(event, handler); },
    registerCommand(name: string, value: typeof command) {
      assert.equal(name, "muse-usage");
      command = value;
    },
  };
  museExtension(api as unknown as ExtensionAPI);
  assert.ok(provider);
  assert.ok(command);
  assert.equal(provider.id, "muse");
  const notices: string[] = [];
  let sessionId = "first";
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (text: string) => notices.push(text) },
  };
  const start = handlers.get("session_start") as (event: object, context: typeof ctx) => void;
  const shutdown = handlers.get("session_shutdown") as () => void;
  start({}, ctx);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /No Muse subscription usage/);

  async function send(id: string, percent: number) {
    const data = [
      { type: "response.subscription_usage", tier: "power", weekly_percent: percent },
      { type: "response.completed", response: { id: "resp", status: "completed", output: [] } },
    ];
    const stream = provider!.streamSimple(provider!.getModels()[0], normalizeContext({ messages: [] }), {
      apiKey: "fake", sessionId: id,
      fetch: async () => new Response(data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const result = await stream.result();
    assert.equal(result.stopReason, "stop");
  }
  await send("first", 93);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /"weekly_percent": 93/);
  shutdown();
  sessionId = "second";
  start({}, ctx);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /No Muse subscription usage/);
  await send("first", 99); // An old in-flight request must not overwrite the new session.
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /No Muse subscription usage/);
  await send("second", 94);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /"weekly_percent": 94/);
  shutdown();
  shutdown();
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /No Muse subscription usage/);
});
