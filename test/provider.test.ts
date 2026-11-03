import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createModels, InMemoryCredentialStore, normalizeContext, Type,
  type AssistantMessageEventStream, type AuthContext, type Provider,
} from "@earendil-works/pi-ai";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import {
  createMuseProvider as createRawMuseProvider, museAuthPath, museHeaders, museUserAgent,
  MUSE_EXEC_LINUX_X64_USER_AGENT, readMuseKey, subscriptionUsage,
} from "../src/provider.ts";
import { museExecProfile, museAgentProfile } from "./fixtures/muse-exec-profile.ts";

// Keep intercepted-transport tests deterministic on hosts without a captured profile.
function createMuseProvider(options: Parameters<typeof createRawMuseProvider>[0] = {}) {
  return createRawMuseProvider({ ...options, env: { MUSE_USER_AGENT: museExecProfile["user-agent"], ...options.env } });
}

const context = normalizeContext({
  systemPrompt: "You are a coding assistant.",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
});
const bashTools = [{ name: "bash", description: "Execute a bash command", parameters: Type.Object({ command: Type.String() }) }];
const bashContext = normalizeContext({ tools: bashTools, messages: context.messages });
const signal = () => new AbortController().signal;
const usage = {
  type: "response.subscription_usage", sequence_number: 2,
  subscription: { tier: "opaque-product-id", weekly: { resets_at: 1794182400, used_percent: 0 },
    window: { resets_at: 1793654921, used_percent: 0, window_duration_mins: 300 } },
};
const completed = {
  type: "response.completed",
  response: {
    id: "resp_test", status: "completed", output: [],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 3, total_tokens: 103 },
  },
};
function textEvents(text: string): unknown[] {
  const item = { id: "msg_1", type: "message", role: "assistant", content: [] };
  return [
    { type: "response.created", response: { id: "resp_test" } }, usage,
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text, annotations: [] }] } },
    completed,
  ];
}
function fakeFetch(events: unknown[], inspect?: (url: string, init: RequestInit) => void): typeof fetch {
  return async (input, init) => {
    inspect?.(String(input), init || {});
    const bytes = new TextEncoder().encode(events.map((data) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    // Split every byte, including inside UTF-8 characters and JSON/SSE boundaries.
    return new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream", "x-test-response": "yes" } });
  };
}
function model(provider: Provider<"openai-responses">) {
  return provider.getModels().find((m) => m.id === "muse-spark-1.3-contributor")!;
}
async function consume(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
  return { events, message: await stream.result() };
}
function authContext(values: Record<string, string> = {}): AuthContext {
  return { env: async (name) => values[name], fileExists: async () => false };
}

test("catalog and OAuth are reused without changing the built-in Meta provider", () => {
  const provider = createMuseProvider({ env: {} });
  const originals = metaProvider().getModels();
  assert.equal(provider.id, "muse");
  assert.equal(provider.auth.oauth?.isSubscription, true);
  assert.deepEqual(provider.getModels(), originals.map((m) => ({ ...m, provider: "muse" })));
  assert.ok(originals.every((m) => m.provider === "meta"));
});

test("empty-preset attribution matches the captured no-tools Muse profile", () => {
  assert.equal(MUSE_EXEC_LINUX_X64_USER_AGENT, museExecProfile["user-agent"]);
  assert.equal(museUserAgent({}, "linux", "x64"), museExecProfile["user-agent"]);
  const { traceparent: _capturedTrace, ...captured } = museExecProfile;
  const { traceparent, ...headers } = museHeaders("muse-spark-1.3-contributor", captured["x-tbh-session-id"], {
    MUSE_USER_AGENT: museUserAgent({}, "linux", "x64"),
  });
  assert.deepEqual(headers, captured);
  assert.match(traceparent!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.throws(() => museUserAgent({}, "darwin", "arm64"), /set MUSE_USER_AGENT/);
  assert.throws(() => museUserAgent({}, "linux", "arm64"), /set MUSE_USER_AGENT/);
  assert.equal(museUserAgent({ MUSE_USER_AGENT: "captured-other-build" }, "darwin", "arm64"), "captured-other-build");
});

test("tool-bearing profile includes the root header captured from native-basic", () => {
  const { traceparent: _trace, ...captured } = museAgentProfile;
  const { traceparent: _generatedTrace, ...headers } = museHeaders("muse-wonder-1.0", captured["x-tbh-session-id"], {
    MUSE_USER_AGENT: captured["user-agent"],
  }, true);
  assert.deepEqual(headers, captured);
});

test("configured identity and independent traces do not invent model-dependent headers", () => {
  const env = { MUSE_USER_AGENT: "muse-build/test (linux; build fixture)", MUSE_CLIENT_ID: "tbh:tui", MUSE_AGENT_ROLE: "agent" };
  const first = museHeaders("muse-spark-1.3-contributor", "session", env);
  const second = museHeaders("muse-wonder-1.0", "session", env);
  assert.equal(first["x-client-id"], "tbh:tui");
  assert.equal(first["user-agent"], env.MUSE_USER_AGENT);
  assert.equal(first["x-tbh-agent-role"], "agent");
  for (const key of ["x-tbh-session-id", "x-meta-ai-gateway-session-id", "x-tbh-thread-id"]) {
    assert.equal(first[key], "session");
  }
  for (const headers of [first, second]) {
    assert.ok(!("x-tbh-contributor-mode" in headers));
    assert.ok(!("x-tbh-root-session-id" in headers));
  }
  assert.notEqual(first.traceparent, second.traceparent);
  assert.throws(() => museHeaders("m", "s", { MUSE_USER_AGENT: "bad\r\ninjection" }), /printable ASCII/);
});

for (const method of ["stream", "streamSimple"] as const) {
  test(`${method}: actual Responses request, UTF-8 streaming, usage and instrumentation`, async () => {
    const seenUsage: unknown[] = [];
    const raw: unknown[] = [];
    const provider = createMuseProvider({ env: {}, onUsage: (u, id) => seenUsage.push({ u, id }) });
    let requests = 0;
    let responses = 0;
    let payloads = 0;
    const { events, message } = await consume(provider[method](model(provider), context, {
      apiKey: "test-inference-key", sessionId: "stable-session", maxRetries: 0,
      headers: { "X-Client-ID": "tbh:tui", "X-Extra": "keep", "user-agent": "configured-agent" },
      onPayload: (payload) => { payloads++; return { ...payload as object, metadata: { marker: "hook" } }; },
      onResponse: (r) => { responses++; assert.equal(r.headers["x-test-response"], "yes"); },
      onProviderStreamEvent: (event) => { raw.push(event); },
      fetch: fakeFetch(textEvents("héllo 🌱"), (url, init) => {
        requests++;
        assert.equal(url, "https://api.meta.ai/v1/responses");
        assert.equal(init.method, "POST");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), "Bearer test-inference-key");
        assert.equal(headers.get("x-client-id"), "tbh:tui");
        assert.equal(headers.get("x-extra"), "keep");
        assert.equal(headers.get("user-agent"), "configured-agent");
        assert.equal(headers.get("x-tbh-session-id"), "stable-session");
        assert.equal(headers.has("x-tbh-contributor-mode"), false);
        assert.equal(headers.has("x-tbh-root-session-id"), false);
        assert.equal(headers.get("accept"), "text/event-stream");
        assert.equal(headers.has("session_id"), false);
        assert.equal(headers.has("x-client-request-id"), false);
        assert.ok([...headers.keys()].every((name) => !name.startsWith("x-stainless-")));
        const body = JSON.parse(init.body as string);
        assert.equal(body.model, "muse-spark-1.3-contributor");
        assert.equal(body.stream, true);
        assert.equal(body.store, false);
        assert.deepEqual(body.metadata, { marker: "hook" });
      }),
    }));
    assert.equal(events[0].type, "start");
    assert.equal(message.stopReason, "stop");
    assert.equal(message.provider, "muse");
    assert.equal(message.content[0].type === "text" && message.content[0].text, "héllo 🌱");
    assert.equal(message.usage.input, 80);
    assert.equal(message.usage.cacheRead, 20);
    assert.equal(message.usage.output, 3);
    assert.equal(message.usage.totalTokens, 103);
    assert.ok(Number.isFinite(message.usage.cost.total));
    assert.equal(requests, 1);
    assert.equal(responses, 1);
    assert.equal(payloads, 1);
    assert.deepEqual(seenUsage, [{ u: { subscription: usage.subscription }, id: "stable-session" }]);
    assert.ok(raw.some((e) => (e as { type: string }).type === usage.type));
  });
}

test("explicit model and request headers survive SDK-header cleanup", async () => {
  const provider = createMuseProvider({ env: {} });
  const selected = { ...model(provider), headers: { "X-Stainless-Runtime": "explicit-model", "User-Agent": "explicit-model-agent", "X-TBH-Agent-Role": "model-agent" } };
  const { message } = await consume(provider.streamSimple(selected, context, {
    apiKey: "test", headers: { "X-Client-Request-ID": "explicit-request", SESSION_ID: "explicit-session", "x-tbh-agent-role": "request-agent" },
    fetch: fakeFetch(textEvents("OK"), (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-stainless-runtime"), "explicit-model");
      assert.equal(headers.get("user-agent"), "explicit-model-agent");
      assert.equal(headers.get("x-tbh-agent-role"), "request-agent");
      assert.equal(headers.get("x-client-request-id"), "explicit-request");
      assert.equal(headers.get("session_id"), "explicit-session");
      assert.equal(headers.has("x-stainless-package-version"), false);
    }),
  }));
  assert.equal(message.stopReason, "stop");
});

test("empty response succeeds and caller can suppress default headers", async () => {
  const provider = createMuseProvider({ env: {} });
  const { message } = await consume(provider.streamSimple(model(provider), context, {
    apiKey: "test", headers: { "X-TBH-Agent-Role": null },
    fetch: fakeFetch([completed], (_url, init) => assert.equal(new Headers(init.headers).has("x-tbh-agent-role"), false)),
  }));
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, []);
});

for (const method of ["stream", "streamSimple"] as const) {
  test(`${method}: bash wire alias restores streamed names, results and follow-up history`, async () => {
    const provider = createMuseProvider({ env: {} });
    const original = structuredClone(bashContext);
    const item = { type: "function_call", id: "fc_bash", call_id: "call_bash", name: "muse_bash", arguments: "" };
    const args = { command: "printf 'bash muse_bash héllo'" };
    const rawNames: string[] = [];
    const stream = provider[method](model(provider), bashContext, {
      apiKey: "test", maxRetries: 0,
      onProviderStreamEvent: (data) => {
        const event = data as { item?: { name?: string } };
        if (event.item?.name) rawNames.push(event.item.name);
      },
      fetch: fakeFetch([
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args) },
        { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: JSON.stringify(args) } }, completed,
      ], (_url, init) => {
        const body = JSON.parse(init.body as string);
        assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["muse_bash"]);
      }),
    });
    const resultPromise = stream.result();
    const { events, message } = await consume(stream);
    assert.equal(await resultPromise, message);
    assert.equal(message.stopReason, "toolUse");
    const partials = events.flatMap((event) => "partial" in event ? [event.partial] : []);
    assert.equal(new Set(partials).size, 1, "preserve the shared live partial");
    for (const partial of partials) for (const part of partial.content) {
      if (part.type === "toolCall") assert.equal(part.name, "bash");
    }
    const end = events.find((event) => event.type === "toolcall_end")!;
    assert.equal(end.type === "toolcall_end" && end.toolCall.name, "bash");
    const call = message.content.find((part) => part.type === "toolCall")!;
    assert.equal(call.name, "bash");
    assert.deepEqual(call.arguments, args);
    assert.ok(rawNames.length > 0 && rawNames.every((name) => name === "muse_bash"));
    assert.deepEqual(bashContext, original);

    const followup = normalizeContext({ tools: bashTools, messages: [...context.messages, message,
      { role: "toolResult", toolCallId: call.id, toolName: "bash", isError: false, timestamp: 2,
        content: [{ type: "text", text: "bash muse_bash héllo" }] },
    ] });
    const saved = structuredClone(followup);
    await consume(provider[method](model(provider), followup, { apiKey: "test",
      fetch: fakeFetch(textEvents("OK"), (_url, init) => {
        const body = JSON.parse(init.body as string);
        const wireCall = body.input.find((entry: { type: string }) => entry.type === "function_call");
        assert.equal(wireCall.name, "muse_bash");
        assert.deepEqual(JSON.parse(wireCall.arguments), args);
        assert.ok(body.input.some((entry: { type: string; call_id?: string }) => entry.type === "function_call_output" && entry.call_id === wireCall.call_id));
      }),
    }));
    assert.deepEqual(followup, saved);
  });
}

test("bash alias avoids current/historical tool-name collisions and replays tool deltas", async () => {
  const { aliasMuseTools } = await import("../src/tool-alias.ts");
  const { getCurrentTools, getDeclaredTools } = await import("@earendil-works/pi-ai");
  const tools = [...bashTools, { ...bashTools[0], name: "muse_bash" }, { ...bashTools[0], name: "muse_bash_2" }];
  const transcript = normalizeContext({ tools, messages: [...context.messages,
    { role: "system", content: "", toolsRemoved: [{ name: "muse_bash_2" }, { name: "bash" }], timestamp: 2 },
    { role: "system", content: "", toolsAdded: bashTools, timestamp: 3 },
  ] });
  const saved = structuredClone(transcript);
  const aliased = aliasMuseTools(transcript);
  assert.deepEqual(getCurrentTools(aliased.context.messages).map((tool) => tool.name).sort(), ["muse_bash_3", "muse_muse_bash"]);
  assert.ok(getDeclaredTools(aliased.context.messages).some((tool) => tool.name === "muse_muse_bash_2"));
  assert.deepEqual(transcript, saved);
  assert.equal(aliasMuseTools(context).context, context);
});

test("removal-only names cannot collide with the bash alias", async () => {
  const { aliasMuseTools } = await import("../src/tool-alias.ts");
  const { getCurrentTools } = await import("@earendil-works/pi-ai");
  const transcript = normalizeContext({ tools: bashTools, messages: [...context.messages,
    { role: "system", content: "", toolsRemoved: [{ name: "muse_bash" }], timestamp: 2 },
  ] });
  assert.deepEqual(getCurrentTools(transcript.messages).map((tool) => tool.name), ["bash"]);
  assert.deepEqual(getCurrentTools(aliasMuseTools(transcript).context.messages).map((tool) => tool.name), ["muse_bash_2"]);
});

test("named and allowed tool choices follow the alias without touching MCP names", async () => {
  const { aliasMuseTools } = await import("../src/tool-alias.ts");
  const aliased = aliasMuseTools(bashContext);
  for (const [choice, expected] of [
    ["auto", "auto"],
    [{ type: "function", name: "bash" }, { type: "function", name: "muse_bash" }],
    [{ type: "custom", name: "bash" }, { type: "custom", name: "muse_bash" }],
    [{ type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "bash" }, { type: "mcp", name: "bash" }] },
      { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "muse_bash" }, { type: "mcp", name: "bash" }] }],
  ]) {
    const saved = structuredClone(choice);
    const options = { sessionId: "stable", toolChoice: choice };
    assert.deepEqual(aliased.options(options)?.toolChoice, expected);
    assert.deepEqual(choice, saved);
    assert.equal(aliasMuseTools(context).options(options), options);
  }
  const provider = createMuseProvider({ env: {} });
  const options: import("@earendil-works/pi-ai").OpenAIResponsesOptions = {
    apiKey: "test", toolChoice: { type: "function", name: "bash" },
    fetch: fakeFetch(textEvents("OK"), (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.tool_choice.name, "muse_bash");
      assert.equal(body.tools[0].name, "muse_bash");
    }),
  };
  await consume(provider.stream(model(provider), bashContext, options));
  assert.deepEqual(options.toolChoice, { type: "function", name: "bash" });
});

test("wire names are unique, bounded and disjoint from all original names", async () => {
  const { museToolNames } = await import("../src/tool-alias.ts");
  const long = "x".repeat(100);
  const firstHash = museToolNames([long]).get(long)!;
  const names = ["read", "muse_read", "muse_read_2", "odd.name/☃", long, firstHash.slice(5)];
  const aliases = museToolNames(names);
  assert.equal(new Set(aliases.values()).size, names.length);
  for (const alias of aliases.values()) {
    assert.match(alias, /^muse_[a-zA-Z0-9_-]{1,59}$/);
    assert.ok(!names.includes(alias));
  }
});

test("prefix-like user tool names survive repeated partial/end/result translation", async () => {
  const { aliasMuseTools, museToolNames } = await import("../src/tool-alias.ts");
  const tools = [bashTools[0], { ...bashTools[0], name: "muse_bash" }];
  const transcript = normalizeContext({ tools, messages: context.messages });
  const names = museToolNames(tools.map((tool) => tool.name));
  const provider = createMuseProvider({ env: {} });
  const item = { type: "function_call", id: "fc_custom", call_id: "call_custom", name: names.get("muse_bash"), arguments: "" };
  const stream = provider.streamSimple(model(provider), transcript, { apiKey: "test", fetch: fakeFetch([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: '{"command":"noop"}' } }, completed,
  ]) });
  const { events, message } = await consume(stream);
  for (const event of events) if ("partial" in event) {
    assert.ok(event.partial.content.every((part) => part.type !== "toolCall" || part.name === "muse_bash"));
  }
  assert.equal(message.content.find((part) => part.type === "toolCall")?.name, "muse_bash");
  assert.equal((await stream.result()).content.find((part) => part.type === "toolCall")?.name, "muse_bash");
  assert.notEqual(aliasMuseTools(transcript).context, transcript);
});

test("tool calls stay in Pi; tool results and images round-trip through the reused adapter", async () => {
  const provider = createMuseProvider({ env: {} });
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "muse_lookup", arguments: "" };
  const tools = [{ name: "lookup", description: "Look up a value", parameters: Type.Object({ name: Type.String() }) }];
  const transcript = normalizeContext({ tools, messages: context.messages });
  const { message } = await consume(provider.streamSimple(model(provider), transcript, {
    apiKey: "test",
    fetch: fakeFetch([
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"name":"value"}' },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"name":"value"}' },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: '{"name":"value"}' } },
      completed,
    ]),
  }));
  assert.equal(message.stopReason, "toolUse");
  const call = message.content.find((c) => c.type === "toolCall")!;
  assert.equal(call.type, "toolCall");
  assert.deepEqual(call.arguments, { name: "value" });
  const followup = normalizeContext({ tools, messages: [
    ...context.messages, message,
    { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 2,
      content: [{ type: "text", text: "result" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
  ] });
  const { message: final } = await consume(provider.streamSimple(model(provider), followup, {
    apiKey: "test", fetch: fakeFetch(textEvents("done"), (_url, init) => {
      const body = JSON.parse(init.body as string);
      const input = body.input as Record<string, unknown>[];
      assert.ok(input.some((i) => i.type === "function_call"));
      assert.ok(input.some((i) => i.type === "function_call_output"));
      assert.ok(JSON.stringify(body).includes("result"));
      assert.ok(JSON.stringify(body).includes("data:image/png;base64,aGVsbG8="));
      assert.ok(JSON.stringify(body).includes("lookup"));
    }),
  }));
  assert.equal(final.stopReason, "stop");
});

test("reasoning and cross-provider handoff preserve Pi transcript semantics", async () => {
  const provider = createMuseProvider({ env: {} });
  const { message } = await consume(provider.streamSimple(model(provider), context, {
    apiKey: "test", reasoning: "high",
    fetch: fakeFetch([
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Think first." },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Think first." }] } },
      completed,
    ], (_url, init) => {
      const body = JSON.parse(init.body as string);
      assert.ok(body.reasoning || JSON.stringify(body.input).includes("configuration_update"));
    }),
  }));
  assert.equal(message.stopReason, "stop");
  assert.ok(message.content.some((block) => block.type === "thinking" && block.thinking === "Think first."));
  const foreign = { ...message, provider: "anthropic", api: "anthropic-messages", content: [
    { type: "text" as const, text: "Earlier answer from another provider" },
  ] };
  const { message: next } = await consume(provider.streamSimple(model(provider), normalizeContext({
    messages: [...context.messages, foreign, { role: "user", content: "continue", timestamp: 3 }],
  }), { apiKey: "test", fetch: fakeFetch(textEvents("continued"), (_url, init) => {
    assert.ok((init.body as string).includes("Earlier answer from another provider"));
  }) }));
  assert.equal(next.stopReason, "stop");
});

test("partial streams fail instead of reporting success", async () => {
  const provider = createMuseProvider({ env: {} });
  const partial = textEvents("partial").slice(0, -1);
  const { message } = await consume(provider.streamSimple(model(provider), bashContext, { apiKey: "test", fetch: fakeFetch(partial) }));
  assert.equal(message.stopReason, "error");
  assert.ok(message.errorMessage);
});

test("attestation denial is surfaced without retry or billing fallback", async () => {
  const provider = createMuseProvider({ env: {} });
  let requests = 0;
  const { message } = await consume(provider.streamSimple(model(provider), bashContext, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => {
      requests++;
      return Response.json({ error: { code: "client_attestation_denied", message: "Muse Code client only", type: "permission_error" } }, { status: 403 });
    },
  }));
  assert.equal(requests, 1);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /client_attestation_denied|Muse Code client only/);
});

test("context overflow is preserved as a provider error", async () => {
  const provider = createMuseProvider({ env: {} });
  const { message } = await consume(provider.streamSimple(model(provider), context, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => Response.json({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }, { status: 400 }),
  }));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /context.*length/i);
});

test("abort reaches the transport and terminates as aborted", async () => {
  const provider = createMuseProvider({ env: {} });
  const controller = new AbortController();
  const { message } = await consume(provider.streamSimple(model(provider), bashContext, {
    apiKey: "test", signal: controller.signal,
    fetch: async (_url, init) => {
      assert.ok(init?.signal);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  }));
  assert.equal(message.stopReason, "aborted");
  assert.ok(message.errorMessage);
});

test("key sources, file rotation, missing/malformed files and no token leakage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-test-"));
  const path = join(directory, "auth.json");
  try {
    const provider = createMuseProvider({ env: { MUSE_AUTH_FILE: path } });
    const auth = provider.auth.apiKey!;
    const input = { ctx: authContext(), signal: signal() };
    assert.equal(await auth.resolve(input), undefined);
    await writeFile(path, JSON.stringify({ api_key: "file-key", access_token: "wrong-token" }));
    assert.equal((await auth.resolve(input))?.auth.apiKey, "file-key");
    assert.equal((await auth.resolve({ ...input, ctx: authContext({ MUSE_API_KEY: "env-key", META_API_KEY: "payg-key" }) }))?.auth.apiKey, "env-key");
    assert.equal((await auth.resolve({ ...input, credential: { type: "api_key", key: "stored-key" } }))?.auth.apiKey, "stored-key");
    await writeFile(path, JSON.stringify({ api_key: "rotated-key" }));
    assert.equal((await auth.resolve(input))?.auth.apiKey, "rotated-key");
    await writeFile(path, JSON.stringify({ providers: { meta: {
      mechanism: "oauth", api_key: "nested-key", access_token: "wrong-identity-token",
    } } }));
    assert.equal((await auth.resolve(input))?.auth.apiKey, "nested-key");
    await writeFile(path, JSON.stringify({ providers: { meta: { access_token: "wrong-token" } } }));
    await assert.rejects(readMuseKey(path), /no api_key/);
    for (const malformed of [null, [], { providers: null }, { providers: { meta: null } }]) {
      await writeFile(path, JSON.stringify(malformed));
      await assert.rejects(readMuseKey(path), /no api_key/);
    }
    await writeFile(path, '{"api_key":"secret-value" garbage');
    await assert.rejects(readMuseKey(path), (error: Error) => !error.message.includes("secret-value") && /Invalid Muse/.test(error.message));
    await writeFile(path, JSON.stringify({ access_token: "wrong-token" }));
    await assert.rejects(readMuseKey(path), /no api_key/);
    await assert.rejects(readMuseKey(directory), /Cannot read Muse/);
    await rm(path);
    assert.equal(await auth.resolve({ ...input, ctx: authContext({ META_API_KEY: "payg-key" }) }), undefined);
    assert.equal(museAuthPath({ XDG_CONFIG_HOME: "/config" }), "/config/muse/auth.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider integrates with Models auth resolution and availability", async () => {
  const models = createModels({ authContext: authContext({ MUSE_API_KEY: "only-test-key" }) });
  models.setProvider(createMuseProvider({ env: { MUSE_AUTH_FILE: "/nonexistent/pi-muse-test" } }));
  assert.ok((await models.getAvailable("muse")).length > 0);
  assert.equal((await models.getAuth("muse"))?.auth.apiKey, "only-test-key");
  const found = models.getModel("muse", "muse-spark-1.3-contributor")!;
  const { message } = await consume(models.streamSimple(found, { messages: context.messages }, {
    fetch: fakeFetch(textEvents("authenticated"), (_url, init) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer only-test-key");
    }),
  }));
  assert.equal(message.stopReason, "stop");
});

test("provider-scoped credential paths and stored identity overrides reach the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-scoped-"));
  try {
    const fileA = join(directory, "a.json");
    const fileB = join(directory, "b.json");
    await writeFile(fileA, JSON.stringify({ api_key: "account-a" }));
    await writeFile(fileB, JSON.stringify({ api_key: "account-b" }));
    const credentials = new InMemoryCredentialStore();
    const provider = createMuseProvider({ env: { MUSE_AUTH_FILE: fileA } });
    const models = createModels({ credentials, authContext: {
      ...authContext(), fileExists: async (path) => path === fileB,
    } });
    models.setProvider(provider);
    const env = { MUSE_AUTH_FILE: fileB };
    assert.equal((await models.getAuth("muse", { env }))?.auth.apiKey, "account-b");
    await credentials.modify("muse", async () => ({ type: "api_key", env: {
      MUSE_AUTH_FILE: fileB, MUSE_USER_AGENT: "muse-build/stored-fixture", MUSE_CLIENT_ID: "tbh:tui",
    } }));
    assert.ok(await models.checkAuth("muse"));
    const { message } = await consume(models.streamSimple(model(provider), { messages: context.messages }, {
      transformHeaders: (headers) => ({ ...headers, "x-tbh-agent-role": null }),
      fetch: fakeFetch(textEvents("scoped"), (_url, init) => {
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), "Bearer account-b");
        assert.equal(headers.get("user-agent"), "muse-build/stored-fixture");
        assert.equal(headers.get("x-client-id"), "tbh:tui");
        assert.equal(headers.has("x-tbh-agent-role"), false);
      }),
    }));
    assert.equal(message.stopReason, "stop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth refresh uses Pi's credential lock and respects cancellation", async () => {
  // Exercise the reused native flow without sending any real login/refresh request.
  const provider = createMuseProvider({ env: {} });
  const original = provider.auth.oauth!;
  let refreshes = 0;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("muse", async () => ({ type: "oauth", access: "expired", refresh: "identity", expires: 0 }));
  provider.auth.oauth = { ...original,
    refresh: async (credential, abort) => {
      abort.throwIfAborted();
      refreshes++;
      return { ...credential, access: "minted-key", expires: Date.now() + 600_000 };
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(provider);
  const [first, second] = await Promise.all([models.getAuth("muse"), models.getAuth("muse")]);
  assert.equal(first?.auth.apiKey, "minted-key");
  assert.equal(second?.auth.apiKey, "minted-key");
  assert.equal(refreshes, 1);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(original.refresh({ type: "oauth", access: "x", refresh: "x", expires: 0 }, aborted.signal));
});

test("unknown event schemas are ignored; subscription payload schema is not guessed", () => {
  for (const value of [null, [], 1, "text", {}, { type: "response.created" }]) assert.equal(subscriptionUsage(value), undefined);
  assert.deepEqual(subscriptionUsage({ type: "response.subscription_usage", tier: "power", weekly: { percent: 93 } }), { tier: "power", weekly: { percent: 93 } });
});
