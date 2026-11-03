// If someone from meta is reading this, please send me an email: vukasin@gostovic.me 😗

import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AuthContext, AuthResult, Model, Provider, ProviderHeaders, StreamOptions,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { aliasMuseTools } from "./tool-alias.ts";

export const PROVIDER_ID = "muse";
// Captured from Muse Code 1.4.14 exec, not derived from this package's version.
// `MUSE_BINARY=... npm run capture:muse` against the installed binary reproduces them.
export const MUSE_EXEC_LINUX_X64_USER_AGENT = "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";
export const MUSE_EXEC_DARWIN_ARM64_USER_AGENT = "muse-build/1.4.14 (non-interactive; macos-aarch64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";
type Env = Record<string, string | undefined>;
export type SubscriptionUsage = Record<string, unknown>;

function headerValue(name: string, value: string): string {
  // Reject control characters before a value can enter an HTTP header.
  if (!value.trim() || /[^\x20-\x7e]/.test(value)) {
    throw new Error(`${name} must be a nonempty printable ASCII header value`);
  }
  return value;
}

export function museAuthPath(env: Env): string {
  return env.MUSE_AUTH_FILE || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse", "auth.json");
}

export async function readMuseKey(path: string, signal?: AbortSignal): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (signal?.aborted) throw error;
    throw new Error("Cannot read Muse credentials; check MUSE_AUTH_FILE permissions");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Never include file contents or JSON.parse's credential-bearing error text.
    throw new Error("Invalid Muse auth.json; log in with Muse again");
  }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const providers = record?.providers as { meta?: { api_key?: unknown } } | undefined;
  const key = record?.api_key ?? providers?.meta?.api_key;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Muse auth.json has no api_key; access_token is not an inference key");
  }
  return key.trim();
}

// Keyed by the Node platform and arch this process runs on.
const CAPTURED_USER_AGENTS: Record<string, string> = {
  "linux-x64": MUSE_EXEC_LINUX_X64_USER_AGENT,
  "darwin-arm64": MUSE_EXEC_DARWIN_ARM64_USER_AGENT,
};

/** Use the captured exec identity; never silently fall back to a Pi User-Agent. */
export function museUserAgent(env: Env, platform: string = process.platform, arch: string = process.arch): string {
  if (env.MUSE_USER_AGENT) return headerValue("MUSE_USER_AGENT", env.MUSE_USER_AGENT);
  const captured = CAPTURED_USER_AGENTS[`${platform}-${arch}`];
  if (!captured) {
    throw new Error("No captured Muse exec identity for this platform; set MUSE_USER_AGENT from your Muse CLI");
  }
  return captured;
}

/** Main-agent attribution captured from Muse exec; model selection stays in the payload. */
export function museHeaders(_modelId: string, sessionId: string, env: Env = process.env, withTools = false): ProviderHeaders {
  return {
    accept: "text/event-stream",
    "accept-encoding": "gzip,deflate,br",
    "x-client-id": headerValue("MUSE_CLIENT_ID", env.MUSE_CLIENT_ID || "tbh:exec"),
    "x-tbh-session-id": sessionId,
    "x-meta-ai-gateway-session-id": sessionId,
    "x-tbh-thread-id": sessionId,
    ...(withTools ? { "x-tbh-root-session-id": sessionId } : {}),
    "x-tbh-agent-role": headerValue("MUSE_AGENT_ROLE", env.MUSE_AGENT_ROLE || "main"),
    traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
    "user-agent": museUserAgent(env),
  };
}

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
  const result: ProviderHeaders = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) result[key.toLowerCase()] = value;
  }
  return result;
}

/** Preserve the server's usage fields rather than guessing a stable quota schema. */
export function subscriptionUsage(event: unknown): SubscriptionUsage | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = event as Record<string, unknown>;
  if (data.type !== "response.subscription_usage") return undefined;
  const { type: _type, sequence_number: _sequence, ...usage } = data;
  return usage;
}

export interface MuseProviderOptions {
  env?: Env;
  onUsage?: (usage: SubscriptionUsage, sessionId: string) => void;
}

export function createMuseProvider(config: MuseProviderOptions = {}): Provider<"openai-responses"> {
  // Pi maps providers/all for dependency-free extensions, but not individual
  // provider subpaths. Resolve through that host-supplied entry point.
  const meta = builtinProviders().find((provider) => provider.id === "meta") as Provider<"openai-responses"> | undefined;
  if (!meta) throw new Error("Muse requires a Pi build with the built-in Meta provider");
  const env = config.env ?? process.env;
  // A fallback for direct SDK callers. Pi supplies its durable session ID.
  const fallbackSessionId = randomUUID();
  const oauth = meta.auth.oauth!;

  async function authPath(ctx: AuthContext): Promise<string> {
    return museAuthPath({
      ...env,
      MUSE_AUTH_FILE: (await ctx.env("MUSE_AUTH_FILE")) ?? env.MUSE_AUTH_FILE,
      XDG_CONFIG_HOME: (await ctx.env("XDG_CONFIG_HOME")) ?? env.XDG_CONFIG_HOME,
    });
  }

  function credentialContext(ctx: AuthContext, values?: Record<string, string>): AuthContext {
    return { ...ctx, env: async (name) => values?.[name] ?? ctx.env(name) };
  }

  async function ambient(ctx: AuthContext, signal: AbortSignal): Promise<AuthResult | undefined> {
    const key = (await ctx.env("MUSE_API_KEY"))?.trim();
    if (key) return { auth: { apiKey: key }, source: "MUSE_API_KEY" };
    const path = await authPath(ctx);
    const fileKey = await readMuseKey(path, signal);
    if (fileKey) return { auth: { apiKey: fileKey }, source: "Muse auth.json" };
    return undefined;
  }

  function prepare<T extends StreamOptions>(model: Model<"openai-responses">, options?: T, withTools = false): T {
    const requestEnv = { ...env, ...options?.env };
    const sessionId = headerValue("sessionId", options?.sessionId || fallbackSessionId);
    const fetcher = options?.fetch ?? globalThis.fetch;
    const explicitHeaders = new Set(Object.keys({ ...model.headers, ...options?.headers }).map((name) => name.toLowerCase()));
    return {
      ...options,
      headers: mergeHeaders(museHeaders(model.id, sessionId, requestEnv, withTools), model.headers, options?.headers),
      // Pi's Responses adapter uses the OpenAI SDK. Its telemetry and session
      // headers are not sent by Muse exec; omit them unless explicitly requested.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        for (const name of [...headers.keys()]) {
          if (!explicitHeaders.has(name) && (name.startsWith("x-stainless-") || name === "session_id" || name === "x-client-request-id")) {
            headers.delete(name);
          }
        }
        return fetcher(input, { ...init, headers });
      },
      onProviderStreamEvent: async (data, model) => {
        const usage = subscriptionUsage(data);
        if (usage) config.onUsage?.(usage, sessionId);
        await options?.onProviderStreamEvent?.(data, model);
      },
    } as T;
  }

  return {
    id: PROVIDER_ID,
    name: "Muse Code",
    baseUrl: meta.baseUrl,
    auth: {
      apiKey: {
        name: "Muse Model API key",
        login: async (interaction) => {
          const key = (await interaction.prompt({ type: "secret", message: "Muse api_key" })).trim();
          if (!key) throw new Error("A nonempty Muse api_key is required");
          return { type: "api_key", key };
        },
        // Availability checks do not read credentials or mint keys.
        check: async ({ credential, ctx }) => {
          ctx = credentialContext(ctx, credential?.env);
          if (credential?.key?.trim()) return { type: "api_key", source: "Stored Muse key" };
          if ((await ctx.env("MUSE_API_KEY"))?.trim()) return { type: "api_key", source: "MUSE_API_KEY" };
          if (await ctx.fileExists(await authPath(ctx))) return { type: "api_key", source: "Muse auth.json" };
          return undefined;
        },
        resolve: async ({ credential, ctx, signal }) => {
          ctx = credentialContext(ctx, credential?.env);
          const result = credential?.key?.trim()
            ? { auth: { apiKey: credential.key.trim() }, source: "Stored Muse key" }
            : await ambient(ctx, signal);
          return result ? { ...result, env: credential?.env } : undefined;
        },
      },
      // Pi owns storage, locking, expiry and refresh of Meta's device login.
      oauth: {
        ...oauth,
        name: "Muse Code subscription",
        refresh: async (credential, signal) => {
          try {
            return await oauth.refresh(credential, signal);
          } catch (error) {
            if (error instanceof Error) error.message = error.message.replaceAll("/login meta", "/login muse");
            throw error;
          }
        },
      },
    },
    getModels: () => meta.getModels().map((model) => ({ ...model, provider: PROVIDER_ID })),
    stream: (model, context, options) => {
      const aliased = aliasMuseTools(context);
      return aliased.restore(meta.stream(model, aliased.context, prepare(model, aliased.options(options), getCurrentTools(context.messages).length > 0)));
    },
    streamSimple: (model, context, options) => {
      const aliased = aliasMuseTools(context);
      return aliased.restore(meta.streamSimple(model, aliased.context, prepare(model, aliased.options(options), getCurrentTools(context.messages).length > 0)));
    },
  };
}
