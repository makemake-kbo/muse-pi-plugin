/** Opt-in, billable comparison of genuine Muse and actual Pi CLI agent requests. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { museAuthPath, readMuseKey } from "../src/provider.js";
import { nativeReplyOK, cliProbePassed, externalCliPath } from "./probe-report.js";

assert.ok(process.argv.includes("--live"), "Pass --live to authorize live inference requests");
const piOnly = process.argv.includes("--pi-only");
const chatOnly = process.argv.includes("--chat-only");
const toolRoundTrip = process.argv.includes("--tool-roundtrip");
assert.ok(!(chatOnly && toolRoundTrip), "--chat-only cannot verify a tool round trip");
const bareMeta = process.argv.includes("--bare-meta");
const installed = process.argv.includes("--installed");
assert.ok(!(installed && bareMeta), "--installed selects the installed muse provider, not meta");
if (!piOnly) assert.ok(process.env.MUSE_BINARY, "Set MUSE_BINARY to the installed Muse executable");
const modelId = process.env.MUSE_CHECK_MODEL || "muse-wonder-1.0";
const thinking = process.env.MUSE_CHECK_THINKING || "minimal";
const plainPrompt = "Reply with exactly OK. Do not call tools.";
const command = toolRoundTrip ? `printf '%s\\n' 'muse-pi-probe-${randomBytes(8).toString("hex")}'` : "";
const prompt = toolRoundTrip
  ? `Call bash exactly once with command ${JSON.stringify(command)}. No other commands or tools. Do not write text before the call. After receiving its output, reply with exactly OK.`
  : plainPrompt;
const project = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-muse-live-"));

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: string) {
  return new Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(stdin);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, stdout, stderr }); });
  });
}

try {
  let native: { exitCode: number | null; signal: string | null; replyOK: boolean; preset: string } | undefined;
  if (!piOnly) {
    const apiKey = await readMuseKey(museAuthPath(process.env));
    assert.ok(apiKey, "No Muse inference key available; log in with Muse first");
    const preset = chatOnly ? "empty" : "native-basic";
    const result = await run(process.env.MUSE_BINARY!, [
      "exec", "--json", "--preset", preset, "--api-key-stdin", "--model", modelId,
      "--reasoning-effort", thinking, "--no-session-log", "--no-foreign-personal-context",
      "--disable-web-tools", "--disable-reminders", "--disable-write", "--disable-shell",
      "--disable-request-user-input", "--approval-judge", "off", "--max-model-steps", "1", plainPrompt,
    ], root, { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config"), NO_COLOR: "1" }, apiKey + "\n");
    const events: unknown[] = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    native = { exitCode: result.exitCode, signal: result.signal, replyOK: nativeReplyOK(events), preset };
  }

  // Exercise the CLI's real authentication, dispatcher, system prompt and tools.
  // Never pass an explicit API key or substitute an SDK-only request here.
  const args = ["--offline"];
  if (!installed) args.push("--no-extensions");
  args.push("-e", join(project, "test/fixtures/cli-diagnostic.ts"));
  if (!bareMeta && !installed) args.push("-e", process.env.MUSE_CHECK_EXTENSION || join(project, "src/index.ts"));
  if (chatOnly) args.push("--no-tools");
  args.push("--no-mcp", "--no-context-files", "--no-skills", "--no-session", "--thinking", thinking,
    "--model", `${bareMeta ? "meta" : "muse"}/${modelId}`, "--print", prompt);
  const result = await run(process.env.MUSE_PI_BINARY || "pi", args, project, {
    ...process.env, PATH: externalCliPath(process.env.PATH), MUSE_DIAGNOSTIC_ALLOWED_COMMAND: command,
  });
  const diagnostics = result.stderr.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
  const last = (kind: string) => diagnostics.findLast((value) => value.diagnostic === kind);
  const status = last("cli-response")?.status;
  const declaredTools = last("cli-payload")?.tools;
  const wireTools = last("cli-payload")?.wireTools;
  const piTools = last("cli-payload")?.piTools;
  const responses = diagnostics.filter((value) => value.diagnostic === "cli-response");
  const toolRoundTripVerified = last("cli-tool-call")?.allowed === true && last("cli-tool-result")?.verified === true
    && last("cli-payload")?.toolResultLinked === true && responses.length === 2 && responses.every((value) => value.status === 200);
  const subscriptionEventSeen = diagnostics.some((value) => value.diagnostic === "cli-subscription-event" && value.seen === true);
  const request = last("cli-request");
  const replyOK = result.stdout.trim() === "OK";
  const errorCode = result.stderr.match(/client_attestation_denied|invalid_api_key|authentication_error|permission_error|billing_not_configured/)?.[0];
  console.log(JSON.stringify({ model: modelId, scope: chatOnly ? "chat-only, NOT agent verification" : "tool-bearing CLI request",
    client: bareMeta ? "meta CLI" : installed ? "installed muse CLI provider" : "source muse CLI provider", native,
    pi: { exitCode: result.exitCode, signal: result.signal, status, declaredTools, wireTools, piTools, replyOK, subscriptionEventSeen, toolRoundTripVerified,
      nodeVersion: request?.nodeVersion, sameMuseInferenceKey: request?.sameMuseInferenceKey, userAgent: request?.userAgent, errorCode },
  }, null, 2));
  const nativeOK = !native || (native.exitCode === 0 && native.replyOK);
  const providerOK = cliProbePassed({ exitCode: result.exitCode, status, declaredTools, wireTools, piTools, replyOK,
    subscriptionEventSeen, toolRoundTripVerified, sameMuseInferenceKey: request?.sameMuseInferenceKey },
  { chatOnly, bareMeta, requireRoundTrip: toolRoundTrip });
  if (!nativeOK || !providerOK) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
