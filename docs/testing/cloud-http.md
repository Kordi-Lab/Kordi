# Desktop HTTP connection reuse

Desktop Cloud requests use the native HTTP plugin so an unreachable system PAC
does not stall WebView networking. The plugin's default client is retained per
app instance, allowing subsequent requests to reuse its connection pool. Bearer
headers remain request-local, and every request still passes the URL scope check.
Separate app profiles do not share connections or cookie stores.

The implementation is a small patch to the pinned HTTP plugin; its provenance,
licenses, and removal criteria are in
[the vendor patch note](../../app/desktop/src-tauri/vendor/tauri-plugin-http/KORDI_PATCH.md).
Explicit connect-timeout, redirect, proxy, or TLS options use a separate client
so they cannot silently alter the default client's behavior. Proxy environment
selection still happens at native application startup.

## Regression checks

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --test cloud_http_pool --test cloud_http_scope --no-default-features
```

The tests exercise real Tauri IPC and a task-owned loopback HTTP server. They count
TCP connections, check per-request authorization and cookies, reject an unapproved
URL after warming the pool, honor explicit redirect settings, and verify that
request/body cancellation leaves subsequent requests usable. Each test uses an
isolated app cache. No test credentials or remote backend are required.

## Optional live measurement

With an already-approved shared development connection running:

```bash
KORDI_HTTP_BENCHMARK_ORIGIN=http://127.0.0.1:18181 \
cargo test -p kordi-desktop --test cloud_http_pool --no-default-features \
  measure_development_tunnel_connection_reuse -- --ignored --nocapture
```

The opt-in test permits only an explicit IPv4 loopback HTTP origin. It reads health
without signing in, warms the pool, and measures eight pairs of fresh-client and
reused-client requests through the real native plugin. Keep aggregate timings in
review evidence; do not publish private target settings or unredacted logs.
This test is intentionally excluded from unattended CI.

Connection reuse reduces repeated connection setup; the network round trip and
server work remain. Measure message requests separately when diagnosing a slow
send, and distinguish acknowledgement from delivery to another client. Multi-second
stalls require tracing the client queue, retries, and synchronization path.
PiP's quiet window is separate from ordinary message delivery. iOS retains its
own URLSession instances; this desktop patch does not change that transport.
