/** Offline CLI smoke fixture. Load before the provider with `pi -ne -e ...`.
 * Intercepts every fetch; never forwards a request or prints credentials.
 */
import assert from "node:assert/strict";

export default function wireCheck(): void {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.meta.ai/v1/responses");
    assert.equal(request.method, "POST");
    assert.ok(process.env.MUSE_USER_AGENT, "Run with the Nix-configured Pi wrapper");
    assert.equal(request.headers.get("user-agent"), process.env.MUSE_USER_AGENT);
    assert.equal(request.headers.get("x-client-id"), "tbh:exec");
    assert.ok(request.headers.get("x-tbh-session-id"));
    if (process.env.MUSE_WIRE_USE_EXISTING_AUTH === "1") {
      const authorization = request.headers.get("authorization");
      assert.ok(authorization?.startsWith("Bearer ") && authorization.length > 7,
        "An inference key must be resolved (value not displayed)");
    } else {
      assert.equal(request.headers.get("authorization"), "Bearer local-wire-placeholder");
    }
    const item = { id: "msg_wire", type: "message", role: "assistant", content: [] };
    const events = [
      { type: "response.created", response: { id: "resp_wire" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "MUSE_WIRE_OK" },
      { type: "response.output_item.done", output_index: 0, item: { ...item,
        content: [{ type: "output_text", text: "MUSE_WIRE_OK", annotations: [] }],
      } },
      { type: "response.completed", response: { id: "resp_wire", status: "completed", output: [] } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
}
