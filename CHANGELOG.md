# Changelog

## 0.1.3

- Capture the Muse Code 1.4.14 macOS arm64 exec User-Agent, so Apple Silicon works out of the box instead of failing with "No captured Muse exec identity for this platform". Only the platform token differs from the Linux x64 capture (`macos-aarch64` vs `linux-x86_64`); every other identity header is unchanged.
- Reject unknown platforms by name through `MUSE_USER_AGENT` only, with tests covering `linux/arm64`, `darwin/x64` and `win32/x64`.

## 0.1.2

- Fix subscription request rejections by namespacing tools on the wire while preserving Pi's tool names, arguments, IDs and transcript.
- Match captured Muse 1.4.14 exec headers and default to its Linux x64 User-Agent.
- Preserve explicit header overrides and streaming callbacks.
- Add tool-mapping regression tests and bounded, opt-in CLI round-trip checks.

## 0.1.1

- Read the current Muse credential format (`providers.meta.api_key`) as well as the legacy top-level `api_key`; never use `access_token` for inference.
- Fix standalone extension loading through Pi's host-mapped `providers/all` entry point. Development dependencies are no longer needed at runtime.
- Add an isolated packaging regression test and an intercepted-fetch CLI smoke fixture.
- Document the exact User-Agent captured from Muse Code 1.4.14 on Linux and how to configure it through Nix. The extension's generic default remains distinct; the Muse identity is an explicit configuration choice.
- Restrict published files and run typechecking/tests before publishing.

Subscription acceptance and billing remain unverified against the live service.

## 0.1.0

- Initial Muse provider with request attribution, native Meta authentication and streaming, and `/muse-usage` reporting.
