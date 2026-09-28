import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import type { OmpLoginSpec } from './providerLogin';

/**
 * Receives a provider's localhost redirect on this Mac during a hosted OMP
 * browser sign-in. The hosted login runs on the server and cannot serve the
 * provider's loopback port, so the desktop listens on it and hands the full
 * address to the page, which submits it as the pasted redirect URL.
 */
export interface LoginCallbackCapture {
  /**
   * Resolves with `http://localhost:<port><path-and-query>` once the browser
   * lands on `path` with a `code` or `error` parameter. Rejects with
   * `port_unavailable` when another program holds the port, and with another
   * code when the capture stops or cannot start.
   */
  start(port: number, path?: string): Promise<string>;
  stop(): Promise<void>;
}

/** OMP's default loopback redirect path, used when the catalog does not name one. */
export const DEFAULT_LOGIN_CALLBACK_PATH = '/auth/callback';

/** The loopback port OMP's browser sign-in redirects to, when Kordi can listen for it. */
export function loginCallbackPort(login: OmpLoginSpec): number | null {
  const port = login.callbackPort;
  return login.kind === 'oauth-code' && !login.manualOnly && port && port > 0 && port < 65536 ? port : null;
}

/** The redirect path to accept on that port: the catalog's, or OMP's default. */
export function loginCallbackPath(login: Pick<OmpLoginSpec, 'callbackPath'>): string {
  const path = typeof login.callbackPath === 'string' ? login.callbackPath.trim() : '';
  return /^\/[^\s?#]*$/.test(path) ? path : DEFAULT_LOGIN_CALLBACK_PATH;
}

/** The code a failed capture rejects with, for example `port_unavailable`. */
export function loginCallbackCaptureErrorCode(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return typeof caught === 'string' ? caught : 'unknown';
}

/** Tauri listener; outside the desktop shell the capture cannot start and the paste field stays. */
export function createDesktopLoginCallbackCapture(): LoginCallbackCapture {
  return {
    start: (port, path) => (isNativeDesktopShell()
      ? invokeDesktop<string>('start_login_callback_capture', { port, callbackPath: path ?? DEFAULT_LOGIN_CALLBACK_PATH })
      : Promise.reject(new Error('capture_unsupported'))),
    stop: async () => {
      if (isNativeDesktopShell()) await invokeDesktop<void>('stop_login_callback_capture');
    },
  };
}
