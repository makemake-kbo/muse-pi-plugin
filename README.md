# pi-muse-provider

Use Muse subscription credentials in Pi, keeping Pi's native agent loop and tools.

## Install

```sh
pi install npm:pi-muse-provider
```

Requires Pi 1.4.0+. For Nix, pin the npm tarball and link `src/` to
`~/.pi/agent/extensions/muse` instead of using `pi install`.

## Use

Log in with Muse, then select a model in Pi:

```text
/model muse/muse-wonder-1.0
/model muse/muse-spark-1.3-contributor
```

Credentials come from `~/.config/muse/auth.json` (respecting `XDG_CONFIG_HOME`).
No separate Pi login is needed. Stored `/login muse` credentials take precedence;
`/logout muse` restores file/environment authentication.

- `MUSE_AUTH_FILE`: override the credential path.
- `MUSE_API_KEY`: use an inference key directly.
- `MUSE_USER_AGENT`: override the captured Muse 1.4.14 Linux x64 identity;
  required on other platforms.
- `/muse-usage`: show the latest server-reported subscription usage.

Tools are namespaced on the wire; Pi keeps their original names and executes them
normally. No automatic billing fallback. In a sandbox, expose the auth file
read-only and restart Pi after Muse replaces it.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
# Opt-in live inference and one harmless printf tool call:
npm run check:live -- --live --pi-only --tool-roundtrip
```
