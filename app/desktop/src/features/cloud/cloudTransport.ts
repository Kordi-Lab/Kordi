// Kordi Cloud traffic must follow one proxy policy on every transport.
//
// The Tauri HTTP plugin runs requests through the native Rust client, which
// shares the macOS proxy policy installed by `system_proxy.rs`: explicit
// environment proxies win, static system proxies are used as a fallback,
// PAC/PAD is never handed to a stack that cannot evaluate it, and loopback
// stays direct. Requests also fail through the caller's abort deadline
// instead of waiting on an unreachable proxy inside the WebView.
//
// The web preview and unit tests keep the platform `fetch`.

function isNativeDesktopShell(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

export function cloudFetchImpl(): typeof fetch {
  if (!isNativeDesktopShell()) {
    return globalThis.fetch.bind(globalThis);
  }
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http');
    return nativeFetch(input, init);
  };
}
