// Kordi Cloud traffic must follow one proxy policy on every transport.
//
// The Tauri HTTP plugin runs requests through the native Rust client, which
// shares the macOS proxy policy installed by `system_proxy.rs`: explicit
// environment proxies win, static system proxies are used as a fallback,
// PAC/PAD is never handed to a stack that cannot evaluate it, and loopback
// stays direct. Requests also fail through the caller's abort deadline
// instead of waiting on an unreachable proxy inside the WebView.
// `nativeCloudFetch` drives the plugin so that every native request and
// response resource is released; see that module for the leak it prevents.
//
// Browser previews use platform fetch. Tests that emulate the native shell
// must supply the HTTP plugin commands or inject a client's fetchImpl.

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_TUNNEL_REQUEST_TIMEOUT_MS = 45_000;

export function defaultCloudRequestTimeoutMs(baseUrl: string): number {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return LOCAL_TUNNEL_REQUEST_TIMEOUT_MS;
    }
  } catch {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function isNativeDesktopShell(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

export function cloudFetchImpl(): typeof fetch {
  if (!isNativeDesktopShell()) {
    return globalThis.fetch.bind(globalThis);
  }
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { nativeCloudFetch } = await import('./nativeCloudFetch');
    return nativeCloudFetch(input, init);
  };
}
