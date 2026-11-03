import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { nativeReplyOK, cliProbePassed, probeCommandOutput, probeShellSafe, externalCliPath } from "../scripts/probe-report.ts";

test("native verification accepts only a completed answer, not prompts or partial output", () => {
  assert.equal(nativeReplyOK([{ payload_type: "turn.input.user", payload: { prompt: "OK" } }]), false);
  assert.equal(nativeReplyOK([{ payload_type: "run.output.delta", payload: { text: "OK" } }]), false);
  assert.equal(nativeReplyOK([{ payload_type: "run.terminal.failed", payload: { terminal: "failed", text: "OK" } }]), false);
  assert.equal(nativeReplyOK([{ payload_type: "run.terminal.completed", payload: { terminal: "completed", text: " OK\n" } }]), true);
  assert.equal(nativeReplyOK([null, "OK", {}, { payload_type: "run.terminal.completed", payload: null }]), false);
});

test("chat-only success cannot pass the default agent verification", () => {
  const chat = { exitCode: 0, status: 200, declaredTools: 0, replyOK: true,
    subscriptionEventSeen: true, sameMuseInferenceKey: true };
  assert.equal(cliProbePassed(chat), false);
  assert.equal(cliProbePassed(chat, { chatOnly: true }), true);
  const agent = { ...chat, declaredTools: 4, piTools: ["read", "bash", "edit", "write"], wireTools: ["muse_read", "muse_bash", "muse_edit", "muse_write"] };
  assert.equal(cliProbePassed(agent), true);
  assert.equal(cliProbePassed({ ...agent, status: 403 }), false);
  assert.equal(cliProbePassed({ ...agent, sameMuseInferenceKey: false }), false);
  assert.equal(cliProbePassed({ ...agent, subscriptionEventSeen: false }), false);
  assert.equal(cliProbePassed({ ...agent, declaredTools: undefined }), false);
  assert.equal(cliProbePassed({ ...agent, wireTools: ["read", "edit", "write"] }), false);
  assert.equal(cliProbePassed({ ...agent, wireTools: ["muse_read", "muse_bash", "muse_lookup", "muse_write"] }), false);
  assert.equal(cliProbePassed({ ...agent, declaredTools: 5, piTools: [...agent.piTools, "muse_bash"],
    wireTools: ["muse_read", "muse_bash_2", "muse_edit", "muse_write", "muse_muse_bash"] }), true);
  assert.equal(cliProbePassed({ ...agent, wireTools: agent.piTools }, { bareMeta: true }), true);
  assert.equal(cliProbePassed(agent, { requireRoundTrip: true }), false);
  assert.equal(cliProbePassed({ ...agent, toolRoundTripVerified: true }, { requireRoundTrip: true }), true);
  assert.equal(cliProbePassed(chat, { chatOnly: true, requireRoundTrip: true }), false);
});

test("the tool probe permits only a canonical nonce-tagged printf", () => {
  const nonce = "muse-pi-probe-0123456789abcdef";
  const command = `printf '%s\\n' '${nonce}'`;
  assert.equal(probeCommandOutput(command), nonce);
  for (const unsafe of [undefined, "pwd", command + "; true", command + "\n", command + " ",
    command.replace(nonce, "$(id)"), command.replace("printf", "echo"), command.replace("abcdef", "abcdez")]) {
    assert.equal(probeCommandOutput(unsafe), undefined);
  }
});

test("printf probe refuses shell prefixes, custom shells and startup hooks", () => {
  assert.equal(probeShellSafe({}, {}), true);
  assert.equal(probeShellSafe({ shellCommandPrefix: "", shellPath: "" }, {}), true);
  assert.equal(probeShellSafe({ shellCommandPrefix: "another-command;" }, {}), false);
  assert.equal(probeShellSafe({ shellPath: "/custom/shell" }, {}), false);
  for (const env of [{ BASH_ENV: "/startup" }, { ENV: "/startup" }, { "BASH_FUNC_printf%%": "() { another-command; }" }]) {
    assert.equal(probeShellSafe({}, env), false);
  }
});

test("npm-injected development CLIs do not shadow installed Pi", async () => {
  const { delimiter } = await import("node:path");
  assert.equal(externalCliPath(["/project/node_modules/.bin", "/node_modules/.bin", "node_modules/.bin/", "/profile/bin", "/usr/bin"].join(delimiter)),
    ["/profile/bin", "/usr/bin"].join(delimiter));
  assert.equal(externalCliPath(undefined), undefined);
});

test("live script refuses to read credentials or run inference without explicit opt-in", { timeout: 15_000 }, () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/live-check.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, MUSE_AUTH_FILE: "/no-such-muse-auth-file", MUSE_BINARY: "/no-such-muse-binary" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass --live to authorize/);
  assert.equal(result.stdout, "");
});
