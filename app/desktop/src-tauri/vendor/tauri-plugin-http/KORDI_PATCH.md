# Kordi HTTP connection reuse patch

This directory vendors `tauri-plugin-http` 2.6.1 from its published crates.io source.

- Upstream repository: https://github.com/tauri-apps/plugins-workspace
- Upstream commit: `3c5d2677677dc7ebea618514af56fc951449cc1b`, `plugins/http`
- Published crate checksum: `d4c07d3be2c68e22e64012eb6c4ec969247e3800da26ef3f3856afbcd07a1ce6`
- Original MIT / Apache-2.0 license files and copyright notices are retained.

The only runtime patch retains a default reqwest client in the plugin's app state.
Requests without per-request client options share its connection pool. Explicit
proxy, TLS, connect-timeout, or redirect settings still build an independent
client. URL scope checks run before either path; headers and authorization remain
per request. Cookie storage, request cancellation, and response streaming use the
upstream implementation.

The root Cargo patch and exact desktop dependency version keep this source in use.
Remove the patch when an upstream release provides equivalent connection reuse,
after running the real IPC/loopback tests in `tests/cloud_http_pool.rs` and the
capability regression in `tests/cloud_http_scope.rs`.

The copy omits the upstream example README, release notes, the redundant crate
lockfile, and local Cargo cache metadata. `Cargo.toml` is the normalized published
manifest with its readme redirected to this patch note.
