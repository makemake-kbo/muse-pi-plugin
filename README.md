# Pi Muse provider

A Pi 1.4.0+ extension that sends Responses API requests with the Muse attribution
headers recorded in [`muse-pi-findings.md`](./muse-pi-findings.md). Pi still owns the
agent loop, tools, transcript, images, reasoning, cancellation, and token accounting.
It does **not** wrap `muse exec` or run a second agent.

**Experimental:** header compatibility is not client attestation. The notes do not
contain a complete Muse request capture or attestation protocol. This extension
cannot promise that Meta will accept a subscription key from Pi or bill it to your
subscription. It does not obtain/replay client certificates or signed attestation
proofs. A `client_attestation_denied` response remains an error; there is no
pay-as-you-go fallback. Check the service's terms before use.

## Load

From this directory, try it for one invocation:

```sh
pi -e ./src/index.ts
```

Or install this local package (no build step):

```sh
pi install /absolute/path/to/muse-pi-plugin
```

Use one method, not both. `/reload` reloads an installed extension.

### Credentials

Choose one:

- If Muse is already logged in, its `api_key` is read from
  `${XDG_CONFIG_HOME:-~/.config}/muse/auth.json` on each request. The extension never
  writes that file. Set `MUSE_AUTH_FILE` to use a different file. File rotation is
  picked up automatically, but expiration is managed by Muse, not this extension.
- Run `/login muse` and choose **Sign in with Meta** for Pi's built-in device flow.
  Pi stores and refreshes a separate `muse` credential. An existing `/login meta`
  session is not automatically copied.
- Set `MUSE_API_KEY` in Pi's environment, or choose the API-key option in `/login muse`.
  Use the Model API `api_key`, **not** Muse's identity `access_token`.

Select the **muse** provider, not the built-in **meta** provider:

```text
/model muse/muse-spark-1.3-contributor
```

Or start with `pi -e ./src/index.ts --model muse/muse-spark-1.3-contributor`.
The catalog and model capabilities come from Pi's built-in Meta provider. Other
models such as `muse-wonder-1.0` are available there too. This extension does not
query `/muse-code/models`; update Pi or use `models.json` to add newer models.

Credential priority follows Pi: explicit request key, stored `muse` credential,
configured key, then ambient sources (`MUSE_API_KEY`, followed by Muse's auth file).
Stored OAuth failures do not fall back to another account. `META_API_KEY` and the
separate `meta-ai` provider are deliberately not used. To switch back to file/env
authentication, remove the stored credential with `/logout muse`.

## Request identity

| Header | Default |
| --- | --- |
| `x-client-id` | `tbh:exec` (`MUSE_CLIENT_ID` can select `tbh:tui`) |
| `x-tbh-contributor-mode` | `true` for `-contributor` models; otherwise `false` |
| `x-tbh-session-id` | Pi session ID |
| `x-meta-ai-gateway-session-id` | Pi session ID |
| `x-tbh-thread-id` | Pi session ID |
| `x-tbh-root-session-id` | Pi session ID |
| `x-tbh-agent-role` | `main` (override with `MUSE_AGENT_ROLE`) |
| `traceparent` | Fresh W3C trace/span IDs per model request |
| `user-agent` | `pi-muse-provider/0.1.0 (<platform>; <arch>)` |

The header **names** and `tbh:exec`/`tbh:tui` values were observed. The boolean
encoding, role value, and mapping of all session/thread/root IDs to Pi's single
session ID are compatibility assumptions, not a verified full client clone.
Contributor mode is selected by the model suffix; no model name is silently changed.

The findings only recorded the User-Agent pattern
`muse-build/<version> (...; build <sha>)`, not an actual version/build. To match your
client's exact value, supply the **complete captured value** via `MUSE_USER_AGENT`
before starting Pi. The default deliberately identifies this bridge rather than
inventing a Muse build. Do not put keys in any identity variables.

Advanced: request headers (including `models.json` headers) override these defaults
case-insensitively; a `null` value suppresses a header. This also permits overriding
any undocumented field encoding. Defaults are assembled in the transport wrapper,
after Pi's `before_provider_headers` hook; that hook can override/suppress named
headers but does not see the generated defaults. Payload, response, and stream
instrumentation is forwarded to Pi unchanged. SDK `options.env` and stored
API-key credential `env` support scoped identity configuration.

## Subscription usage

After receiving a response, run `/muse-usage`. It shows the latest
`response.subscription_usage` event for the current Pi session, with a timestamp.
It makes no extra API call and displays the server's JSON fields without guessing
an undocumented usage schema. No event means subscription accounting is **unknown**,
not zero. HTTP 200 alone does not prove subscription billing.

Usage is held in memory, cleared on session change/reload, and not added to model
context or persisted. This command uses Pi UI notifications (interactive/RPC);
print/JSON callers can observe the event through `onProviderStreamEvent` instead.
Pi's ordinary token/cost totals use its existing model metadata; they are not the
subscription's quota percentages or evidence of an actual monetary charge.

## Verify / develop

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests use fake keys, temporary credential files, and an intercepted fetch transport
with byte-fragmented SSE. They cover request headers/auth, tool round-trips/images,
Unicode, token usage, instrumentation, cancellation, partial streams, HTTP errors,
credential refresh orchestration, and session-local usage. No live subscription
request has been made or verified here. Runtime imports are supplied by Pi; npm
dependencies are only for development.

For a local, offline extension-loading check (using a non-secret placeholder):

```sh
MUSE_API_KEY=placeholder pi --offline --no-extensions -e ./src/index.ts --list-models muse
```
