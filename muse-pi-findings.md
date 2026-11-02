# Pi + Muse Code subscription: findings (2026-11-01)

## Goal
Pi extension that sends messages through the Muse Code subscription. Reported symptom: the API key pi uses
"stopped counting subscription usage".

## Root cause
Meta now enforces **client attestation** on subscription-billed keys. Recent pi sessions that hit `api.meta.ai`
fail with:

```
403 {"code":"client_attestation_denied",
     "message":"This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests
                from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for
                other clients.",
     "type":"permission_error"}
```

Seen in `~/.pi/agent/sessions/--home-makemake-Documents-code-c-source-sdk-2013-security-audit--/`:
- `2026-10-31T18-04-45-...jsonl` (model `muse-spark-1.3-contributor`)
- `2026-11-01T07-12-35-...jsonl` (model `muse-wonder-1.0`)

Last pi sessions that worked and ran long: 2026-10-28 and earlier. So the restriction started between 10-28 and 10-31.
It is a deliberate server-side policy, not a pi bug, and not something a pi extension can fix by itself.

## What pi does today (pi 1.4.0)
- Built-in `meta` provider (`packages/ai/src/providers/meta.ts`), OpenAI Responses API at `https://api.meta.ai/v1`.
- `/login meta` does the device flow at `auth.meta.com` with client id `1031625952748946`, then mints a Model API
  key at `POST https://api.meta.ai/muse-code/key`. The minted key lives about a day and is re-minted on refresh.
- The minted key is byte-identical to the `api_key` in muse's `~/.config/muse/auth.json`. Same key, same subscription.
- Pi sends no client identification headers.

## What muse does differently
Captured by pointing a copy of the credential file at a local listener (`XDG_CONFIG_HOME` override, nothing forwarded):
- Auth: `Authorization: Bearer <api_key>` (not `access_token`, which gets 401 on inference).
- Headers on `POST /v1/responses`: `x-client-id: tbh:exec|tbh:tui`, `x-tbh-contributor-mode`, `x-tbh-session-id`,
  `x-meta-ai-gateway-session-id`, `x-tbh-thread-id`, `x-tbh-root-session-id`, `x-tbh-agent-role`, `traceparent`,
  `user-agent: muse-build/<version> (...; build <sha>)`. Model names carry a `-contributor` suffix when contributor mode is on.
- `GET /muse-code/models` for the catalog.
- The binary contains a `client_attestation`-style error path, `missing_request_attribution`, and an mTLS client option.
  I did not investigate how attestation is actually proven.
- The response stream includes `response.subscription_usage` with tier, 5-hour window percent and weekly percent.
  This is what `muse usage` shows.

## Diagnostics I ran (disclosure)
I sent roughly ten direct requests to `api.meta.ai` using muse's `api_key`, including variants with
`x-client-id` set to `tbh:tui`, `tbh:exec` and `pi`. All returned 200 and showed the subscription event.
One ~800 KB request moved usage from 4% to 5% (window) and 92% to 93% (weekly).
These came from my probe scripts, not from pi, so they say nothing reliable about why pi is blocked.
The server may attest differently per client or traffic pattern. I stopped there on purpose. Replaying
muse's identity headers or user-agent from another client would be bypassing Meta's access control, so I
did not turn them into an extension.

Side note: pi's `auth.json` has a separate `meta-ai` entry, a pay-as-you-go Model API key. It returns
`402 billing_not_configured` (billing issue on team `3350472545139177`; see https://dev.meta.ai/billing/).

## Options
1. **Wrap the real `muse` binary as a pi provider** (like the `pi-claude-cli` package already installed).
   Requests then come from the genuine Muse Code client, which is the permitted use. Candidates:
   `muse exec --json` (JSONL events, one prompt per run, `--session-id`/`resume` for continuity) or
   `muse serve` (MSP session host over stdio; schema via `muse schema`). Trade-off: muse runs its own agent loop
   and tools, so pi would mostly render its output rather than drive tool calls.
2. **Pay-as-you-go key in pi.** Fix billing on the `meta-ai` key (or set `META_API_KEY`) and use pi's built-in
   `meta` provider. Usage is billed to the API account, not the subscription.
3. **Use `muse` directly** for subscription usage.

## Not done
No extension was written. Option 1 is ready to build once you confirm. Check Meta's terms
(https://dev.meta.ai/legal/terms-of-service) if you want to be sure that driving `muse` headlessly is covered.

## State of the account when I stopped
`muse usage`: window 5% (resets in about 6 minutes), weekly 93% (resets in about 3.5 hours), tier Muse Code Power.
Temporary credential copies I made in the scratchpad were deleted.

## Implementation follow-up

A direct Pi provider now exists in `src/index.ts` / `src/provider.ts`; see `README.md`.
It reuses Pi's Meta authentication/catalog/Responses transport under the separate
`muse` provider, adds the observed attribution header names, and exposes the latest
subscription usage event via `/muse-usage`. It does not wrap the Muse binary.

The notes above do not establish a complete client identity: the precise User-Agent,
boolean header encoding, role, session/thread relationships, and attestation proof
were not captured. The implementation documents its assumptions and accepts an exact
User-Agent through `MUSE_USER_AGENT`; it does not fabricate a client certificate or
claim that headers satisfy attestation. Subscription acceptance/billing still needs
live verification. No live request was made during this implementation.

Verification: typechecking and 17 offline tests passed with both npm Pi AI 1.4.0 and
the installed Nix Pi AI 1.4.0. The installed Pi CLI loaded the extension and listed
all six `muse` models using a dummy key with `--offline`.
