/** Muse Code 1.4.14-R7309.1 POST /v1/responses, dummy-key local captures.
 * `empty` declares no tools; `native-basic` declares the `muse` tool and adds a root session header.
 * Session/trace values below are normalized, not credentials.
 */
export const museExecProfile = {
  accept: "text/event-stream",
  "accept-encoding": "gzip,deflate,br",
  "x-client-id": "tbh:exec",
  "x-tbh-session-id": "00000000-0000-7000-8000-000000000001",
  "x-meta-ai-gateway-session-id": "00000000-0000-7000-8000-000000000001",
  "x-tbh-thread-id": "00000000-0000-7000-8000-000000000001",
  "x-tbh-agent-role": "main",
  traceparent: "00-00000000000070008000000000000001-0000000000000001-01",
  "user-agent": "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)",
};

export const museAgentProfile = {
  ...museExecProfile,
  "x-tbh-root-session-id": museExecProfile["x-tbh-session-id"],
};
