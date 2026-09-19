# Network proxy policy

Kordi clients must keep working when a machine or network has a broken proxy
configuration. Every transport follows one policy so a proxy problem cannot
stall sends, sync, or sign-in.

## Decision order

1. **Explicit proxy environment** (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`,
   `NO_PROXY`, and their lowercase variants) wins on native transports.
2. **Static system proxy**: macOS Web Proxy / Secure Web Proxy settings are
   used as a consistent fallback.
3. **PAC/PAD is bypassed**: automatic proxy configuration and proxy
   auto-discovery require a JavaScript evaluator that the native Rust stack
   does not have. Kordi never hands an unreachable PAC endpoint to a stack that
   cannot evaluate it; traffic continues directly instead of waiting.
4. **Loopback stays direct**: `localhost`, `127.0.0.1`, and `::1` are always
   excluded from proxying.
5. **Bounded failure**: a request that cannot be routed fails within the
   request deadline with an actionable error instead of hanging in a sending
   state. Retries are limited to failures that happened before any request
   bytes reached the network.

## Per-transport implementation

| Transport | Implementation |
| --- | --- |
| Desktop native (OAuth, providers, sidecars, updater) | `app/desktop/src-tauri/src/system_proxy.rs` resolves the policy once at startup and installs `*_PROXY` / `NO_PROXY` environment variables before any HTTP client is built. |
| Desktop Cloud API (renderer) | `app/desktop/src/features/cloud/cloudTransport.ts` routes Cloud requests through the Tauri HTTP plugin (Rust `reqwest`), so the renderer shares the native policy instead of WebKit's system PAC evaluation. |
| iOS Cloud API | `app/ios/Kordi/Core/API/NetworkProxyPolicy.swift` classifies proxy state and failures; `CloudAPIClient` uses a proxy-disabled direct session for loopback and retries pre-connection failures once directly. Only proxy-specific CFNetwork errors on a system-routed attempt receive proxy guidance; direct and ambiguous failures use the normal network error. |

## Behavior notes

- `URLSessionConfiguration.waitsForConnectivity` must stay disabled for Cloud
  API sessions. While a PAC resolver is stuck, that flag suspends the session
  timers, which left optimistic messages in a permanent sending state.
- The desktop renderer keeps WebSocket transports on WebKit. Real-time
  connections reconnect and the API polling paths use the native transport, so
  a proxy failure degrades live push without blocking sends.
- When PAC/PAD is enabled without a static fallback, the desktop logs that
  native traffic continues directly. Configure a static Web Proxy/Secure Web
  Proxy or launch with `HTTPS_PROXY` to route through a proxy instead.
