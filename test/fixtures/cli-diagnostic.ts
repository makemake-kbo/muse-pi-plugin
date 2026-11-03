/** Observe real CLI auth without replacing credentials. Live requests are billable.
 * Cap requests/output. Deny every tool except one strictly allowlisted printf probe.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { museAuthPath, readMuseKey } from "../../src/provider.ts";
import { probeCommandOutput, probeShellSafe } from "../../scripts/probe-report.ts";

export default function cliDiagnostic(pi: ExtensionAPI): void {
  const command = process.env.MUSE_DIAGNOSTIC_ALLOWED_COMMAND;
  const expectedOutput = probeCommandOutput(command);
  let allowedCallId: string | undefined;
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.meta.ai/v1/responses") return originalFetch(input, init);
    if (++requests > 2) throw new Error("Diagnostic inference request budget exceeded");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const key = await readMuseKey(museAuthPath(process.env));
    console.error(JSON.stringify({ diagnostic: "cli-request", nodeVersion: process.version, userAgent: headers.get("user-agent"),
      museClientId: headers.get("x-client-id"), sameMuseInferenceKey: !!key && headers.get("authorization") === `Bearer ${key}`,
      rootSessionPresent: headers.has("x-tbh-root-session-id"),
    }));
    const response = await originalFetch(input, init);
    console.error(JSON.stringify({ diagnostic: "cli-response", status: response.status }));
    return response;
  };
  pi.on("before_provider_request", (event) => {
    if (!event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as Record<string, unknown>;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const input = Array.isArray(payload.input) ? payload.input : [];
    const toolResultLinked = input.some((call) => call.type === "function_call" && typeof call.call_id === "string"
      && input.some((result) => result.type === "function_call_output" && result.call_id === call.call_id));
    console.error(JSON.stringify({ diagnostic: "cli-payload", model: payload.model, tools: tools.length,
      wireTools: tools.map((tool) => tool.name), piTools: pi.getActiveTools(), toolResultLinked, reasoning: payload.reasoning,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)), outputCap: 512,
    }));
    return { ...payload, max_output_tokens: 512 };
  });
  pi.on("provider_stream_event", (event) => {
    const data = event.data as { type?: unknown } | null;
    if (data?.type === "response.subscription_usage") console.error(JSON.stringify({ diagnostic: "cli-subscription-event", seen: true }));
  });
  pi.on("tool_call", (event) => {
    if (expectedOutput && !allowedCallId && !event.parentToolCallId && event.toolName === "bash"
      && probeShellSafe(pi.getSettings(), process.env)
      && pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path === "builtin:bash"
      && event.input.command === command && Object.keys(event.input).every((key) => key === "command" || key === "timeout")) {
      allowedCallId = event.toolCallId;
      event.input.timeout = 5;
      console.error(JSON.stringify({ diagnostic: "cli-tool-call", toolName: event.toolName, allowed: true }));
      return;
    }
    return { block: true, terminate: true, reason: "Diagnostic run: tool execution not allowlisted" };
  });
  pi.on("tool_result", (event) => {
    if (event.toolCallId !== allowedCallId) return;
    const output = event.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
    console.error(JSON.stringify({ diagnostic: "cli-tool-result", toolName: event.toolName,
      verified: !event.isError && event.toolName === "bash" && output === expectedOutput,
    }));
  });
}
