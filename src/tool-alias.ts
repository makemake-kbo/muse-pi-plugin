import { createHash } from "node:crypto";
import { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, TranscriptContext, StreamOptions, OpenAIResponsesOptions } from "@earendil-works/pi-ai";

/** Disjoint, valid wire names make reverse translation idempotent on live partials. */
export function museToolNames(sourceNames: Iterable<string>): Map<string, string> {
  const names = new Set(sourceNames);
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const name of names) {
    const prefixed = `muse_${name}`;
    const base = /^[a-zA-Z0-9_-]{1,64}$/.test(prefixed) ? prefixed
      : `muse_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 46)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
    let alias = base;
    for (let suffix = 2; names.has(alias) || used.has(alias); suffix++) {
      const tail = `_${suffix}`;
      alias = base.slice(0, 64 - tail.length) + tail;
    }
    used.add(alias);
    result.set(name, alias);
  }
  return result;
}

/** Literal tool names can trigger subscription-client classification. Namespace
 * every declared tool, not a guessed denylist; Pi retains its original registry.
 */
export function aliasMuseTools(context: TranscriptContext): {
  context: TranscriptContext;
  options: <T extends StreamOptions>(options: T | undefined) => T | undefined;
  restore: (stream: AssistantMessageEventStream) => AssistantMessageEventStream;
} {
  const names = new Set(getDeclaredTools(context.messages).map((tool) => tool.name));
  for (const message of context.messages) {
    if (message.role === "system") for (const tool of message.toolsRemoved ?? []) names.add(tool.name);
    if (message.role === "assistant") {
      for (const content of message.content) if (content.type === "toolCall") names.add(content.name);
    } else if (message.role === "toolResult") names.add(message.toolName);
  }
  if (!names.size) return { context, options: (options) => options, restore: (stream) => stream };
  const toWireNames = museToolNames(names);
  const fromWireNames = new Map([...toWireNames].map(([name, alias]) => [alias, name]));
  const toWire = <T extends { name: string }>(tool: T): T => ({ ...tool, name: toWireNames.get(tool.name) ?? tool.name });
  const wireContext = normalizeContext({ messages: context.messages.map((message) => {
    switch (message.role) {
      case "system": return { ...message, toolsAdded: message.toolsAdded?.map(toWire), toolsRemoved: message.toolsRemoved?.map(toWire) };
      case "assistant": return { ...message, content: message.content.map((part) => part.type === "toolCall" ? toWire(part) : part) };
      case "toolResult": return { ...message, toolName: toWireNames.get(message.toolName) ?? message.toolName };
      default: return message;
    }
  }) });
  function renameChoice(choice: unknown): unknown {
    if (!choice || typeof choice !== "object") return choice;
    const value = choice as Record<string, unknown>;
    if ((value.type === "function" || value.type === "custom") && typeof value.name === "string" && toWireNames.has(value.name)) {
      return { ...value, name: toWireNames.get(value.name) };
    }
    if (value.type === "allowed_tools" && Array.isArray(value.tools)) return { ...value, tools: value.tools.map(renameChoice) };
    return choice;
  }
  function restoreMessage(message: AssistantMessage): AssistantMessage {
    // Preserve the shared live partial and IDs/arguments. Domain and range are
    // disjoint, so repeated event/result translation cannot rename a tool twice.
    for (const part of message.content) if (part.type === "toolCall") part.name = fromWireNames.get(part.name) ?? part.name;
    return message;
  }
  return {
    context: wireContext,
    options: (options) => {
      if (!options) return options;
      const choice = (options as OpenAIResponsesOptions).toolChoice;
      const wireChoice = renameChoice(choice);
      return wireChoice === choice ? options : { ...options, toolChoice: wireChoice };
    },
    // Forward the host stream: no second parser, queue or pump. Bind native
    // methods to the original receiver because the class has private state.
    restore: (stream) => new Proxy(stream, {
      get(target, property) {
        if (property === "result") return async () => restoreMessage(await target.result());
        if (property === Symbol.asyncIterator) return async function* () {
          for await (const event of target) {
            if ("partial" in event) restoreMessage(event.partial);
            if (event.type === "toolcall_end") event.toolCall.name = fromWireNames.get(event.toolCall.name) ?? event.toolCall.name;
            if (event.type === "done") restoreMessage(event.message);
            if (event.type === "error") restoreMessage(event.error);
            yield event;
          }
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" && property !== "constructor" ? value.bind(target) : value;
      },
    }),
  };
}
