import { delimiter } from "node:path";
import { museToolNames } from "../src/tool-alias.ts";

/** npm scripts prepend dev CLIs; don't silently substitute one for installed Pi. */
export function externalCliPath(path: string | undefined): string | undefined {
  return path?.split(delimiter).filter((entry) => !/(^|[\\/])node_modules[\\/]\.bin[\\/]?$/.test(entry)).join(delimiter);
}

/** Parse only Muse's completed terminal record, not echoed prompts or deltas. */
export function nativeReplyOK(events: unknown[]): boolean {
  return events.some((value) => {
    if (!value || typeof value !== "object") return false;
    const event = value as Record<string, unknown>;
    if (event.payload_type !== "run.terminal.completed" || !event.payload || typeof event.payload !== "object") return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.terminal === "completed" && typeof payload.text === "string" && payload.text.trim() === "OK";
  });
}

export interface CliProbeResult {
  exitCode: number | null;
  status: unknown;
  declaredTools: unknown;
  wireTools?: unknown;
  piTools?: unknown;
  toolRoundTripVerified?: boolean;
  replyOK: boolean;
  subscriptionEventSeen: boolean;
  sameMuseInferenceKey: unknown;
}

/** A successful chat-only probe must never pass the default agent check. */
export function cliProbePassed(result: CliProbeResult, {
  chatOnly = false, bareMeta = false, requireRoundTrip = false,
}: { chatOnly?: boolean; bareMeta?: boolean; requireRoundTrip?: boolean } = {}): boolean {
  const wireTools = result.wireTools;
  const piTools = result.piTools;
  const expectedNames = Array.isArray(piTools) && piTools.every((name) => typeof name === "string")
    ? bareMeta ? piTools : [...museToolNames(piTools).values()] : [];
  const toolsOK = chatOnly ? !requireRoundTrip : (typeof result.declaredTools === "number" && result.declaredTools >= 4
    && Array.isArray(wireTools) && wireTools.length === result.declaredTools && Array.isArray(piTools) && piTools.length >= 4
    && ["read", "bash", "write"].every((name) => piTools.includes(name)) && expectedNames.length === piTools.length
    && expectedNames.every((name) => wireTools.includes(name)));
  return result.exitCode === 0 && result.status === 200 && result.replyOK && result.subscriptionEventSeen
    && result.sameMuseInferenceKey === true && toolsOK && (!requireRoundTrip || result.toolRoundTripVerified === true);
}

/** Only this harmless, nonce-tagged printf may run during a tool round-trip probe. */
export function probeCommandOutput(command: string | undefined): string | undefined {
  const match = /^printf '%s\\n' '(muse-pi-probe-[0-9a-f]{16})'$/.exec(command ?? "");
  return match && match[0] === command ? match[1] : undefined;
}

export function probeShellSafe(settings: { shellCommandPrefix?: string; shellPath?: string }, env: NodeJS.ProcessEnv): boolean {
  return !settings.shellCommandPrefix && !settings.shellPath && !env.BASH_ENV && !env.ENV
    && !Object.keys(env).some((name) => name.startsWith("BASH_FUNC_"));
}
