import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useCallback, useEffect, useState } from 'react';

import { DOCUMENT_SHARE_OPEN_EVENT, documentShareTokenFromUrl } from './documentShareToken';

export {
  DOCUMENT_SESSION_OPEN_EVENT,
  DOCUMENT_SHARE_OPEN_EVENT,
  dispatchDocumentSessionOpen,
  documentShareTokenFromUrl,
  openDocumentShareLink,
} from './documentShareToken';

/** The share token from a `kordi://document/<token>` deep link or an in-app `kordi.ai/d/<token>` link. */
export function usePendingDocumentShare() {
  const [token, setToken] = useState<string | null>(() => (
    typeof window === 'undefined' || typeof window.location?.href !== 'string'
      ? null
      : documentShareTokenFromUrl(window.location.href)
  ));

  const remember = useCallback((candidate: string | null | undefined) => {
    const next = documentShareTokenFromUrl(candidate);
    if (next) setToken(next);
  }, []);

  const dismiss = useCallback(() => setToken(null), []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const openFromEvent = (event: Event) => remember((event as CustomEvent<string>).detail);
    window.addEventListener(DOCUMENT_SHARE_OPEN_EVENT, openFromEvent);
    return () => window.removeEventListener(DOCUMENT_SHARE_OPEN_EVENT, openFromEvent);
  }, [remember]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;

    void getCurrent()
      .then((urls) => {
        if (!disposed) urls?.forEach(remember);
      })
      .catch(() => undefined);
    void onOpenUrl((urls) => {
      urls.forEach(remember);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [remember]);

  return { token, dismiss };
}
