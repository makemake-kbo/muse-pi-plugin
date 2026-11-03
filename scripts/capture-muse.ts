/** Local-only identity capture using a dummy key and an empty Muse home. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.ok(process.env.MUSE_BINARY, "Set MUSE_BINARY to the installed Muse executable");
const home = await mkdtemp(join(tmpdir(), "pi-muse-capture-"));
let captured = false;
const server = createServer((request, response) => {
  if (request.method === "GET") {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [], data: [] }));
    return;
  }
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    captured = true;
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "authorization"));
    const payload = JSON.parse(body) as Record<string, unknown>;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    console.log(JSON.stringify({ method: request.method, path: request.url, headers,
      payload: { model: payload.model, keys: Object.keys(payload), tools: tools.length,
        toolNames: tools.map((tool) => tool.name ?? tool.function?.name), metadata: payload.metadata },
    }, null, 2));
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Local capture complete", type: "authentication_error" } }));
  });
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = spawn(process.env.MUSE_BINARY, [
    "exec", "--json", "--preset", process.env.MUSE_CAPTURE_PRESET || "empty", "--api-key-stdin", "--model", process.env.MUSE_CAPTURE_MODEL || "muse-spark-1.3-contributor",
    "--base-url", `http://127.0.0.1:${address.port}/v1`, "--reasoning-effort", "minimal",
    ...(process.env.MUSE_CAPTURE_CONTRIBUTOR_MODE ? ["--contributor-mode", process.env.MUSE_CAPTURE_CONTRIBUTOR_MODE] : []),
    "--no-session-log", "--no-foreign-personal-context", "--disable-web-tools", "--disable-reminders",
    "--disable-write", "--disable-shell", "--disable-request-user-input", "--approval-judge", "off",
    "--max-model-steps", "1", "Reply OK.",
  ], { cwd: home, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), NO_COLOR: "1" },
    stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("local-capture-placeholder\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
  } finally { clearTimeout(timer); }
  assert.ok(captured, "Muse did not reach the local listener");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
