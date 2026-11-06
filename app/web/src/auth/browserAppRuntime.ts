/** An explicit target keeps desktop browser fixtures on their existing contract. */
export function isBrowserAppRuntime(env?: { VITE_KORDI_WEB_APP?: string }): boolean {
  if (typeof window === 'undefined' || window.__TAURI_INTERNALS__) return false;
  const active = env ?? (import.meta as ImportMeta & { env?: { VITE_KORDI_WEB_APP?: string } }).env;
  return active?.VITE_KORDI_WEB_APP === '1';
}

const BROWSER_SESSION_PREFIX = 'kordi-browser:';

/** A public account marker, never a credential. Only the HttpOnly cookie authenticates. */
export function browserSessionMarker(accountId: string): string {
  return `${BROWSER_SESSION_PREFIX}${encodeURIComponent(accountId)}`;
}

export function browserSessionAccountId(token: string): string | null {
  if (!token.startsWith(BROWSER_SESSION_PREFIX)) return null;
  try {
    return decodeURIComponent(token.slice(BROWSER_SESSION_PREFIX.length)) || null;
  } catch {
    return null;
  }
}
