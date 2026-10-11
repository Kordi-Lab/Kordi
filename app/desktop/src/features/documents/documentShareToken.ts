/** Share token parsing for `kordi://document/<token>` and `https://kordi.ai/d/<token>`. No Tauri imports. */
const DOCUMENT_SHARE_TOKEN_PATTERN = /^kordi_ds_[A-Za-z0-9_-]{43}$/;

/** Fired when a `kordi.ai/d/` link inside the app is opened. The detail is the share token. */
export const DOCUMENT_SHARE_OPEN_EVENT = 'kordi-document-share-open';

/** Fired by **Open in session** in the shared document dialog. The detail is the session id. */
export const DOCUMENT_SESSION_OPEN_EVENT = 'kordi-document-session-open';

export function documentShareTokenFromUrl(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  if (DOCUMENT_SHARE_TOKEN_PATTERN.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const trustedWebHost = ['kordi.ai', 'www.kordi.ai'].includes(url.hostname.toLowerCase());
    const candidate = url.protocol === 'kordi:' && url.hostname === 'document'
      ? pathParts[0]
      : url.protocol === 'https:' && trustedWebHost && pathParts[0] === 'd' && pathParts.length === 2
        ? pathParts[1]
        : null;
    return candidate && DOCUMENT_SHARE_TOKEN_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Opens the shared document reader for a link clicked inside the app. Returns false for other links. */
export function openDocumentShareLink(href: string): boolean {
  const token = documentShareTokenFromUrl(href);
  if (!token || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<string>(DOCUMENT_SHARE_OPEN_EVENT, { detail: token }));
  return true;
}

export function dispatchDocumentSessionOpen(sessionId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(DOCUMENT_SESSION_OPEN_EVENT, { detail: sessionId }));
}
