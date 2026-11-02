# Changelog

## 0.1.1

- Read the current Muse credential format (`providers.meta.api_key`) as well as the legacy top-level `api_key`; never use `access_token` for inference.
- Fix standalone extension loading through Pi's host-mapped `providers/all` entry point. Development dependencies are no longer needed at runtime.
- Add an isolated packaging regression test and an intercepted-fetch CLI smoke fixture.
- Document the exact User-Agent captured from Muse Code 1.4.14 on Linux and how to configure it through Nix. The extension's generic default remains distinct; the Muse identity is an explicit configuration choice.
- Restrict published files and run typechecking/tests before publishing.

Subscription acceptance and billing remain unverified against the live service.

## 0.1.0

- Initial Muse provider with request attribution, native Meta authentication and streaming, and `/muse-usage` reporting.
