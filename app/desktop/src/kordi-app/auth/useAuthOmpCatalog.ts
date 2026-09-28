import { useEffect, useRef, useState } from 'react';
import { isOmpUnavailableError } from '@/features/cloud/ompAvailability';
import { loadedPinnedOmpCatalog, loadPinnedOmpCatalog, refreshOmpCatalog, type OmpCatalog, type OmpCatalogEntry } from './ompCatalog';

type HostedCatalogLoader = (() => Promise<{ providers: OmpCatalogEntry[]; version?: string | null }>) | null;

const emptyCatalog: OmpCatalog = { version: null, providers: [] };

/** The bundled catalog chunk failed and the server's catalog stands in. */
export const BUNDLED_CATALOG_FALLBACK_NOTICE = 'The bundled provider list did not load, so this list comes from the server.';
/** Neither the bundled nor the server catalog loaded. */
export const CATALOG_UNAVAILABLE_NOTICE = 'The provider list did not load. Only local providers and Custom API are shown; reopen this page to try again.';
/** This Mac's accounts did not load, so the list comes from the catalog alone. */
export const LOCAL_ACCOUNTS_UNAVAILABLE_NOTICE = 'Accounts on this Mac did not load, so saved accounts may be missing. Refresh to try again.';

/**
 * Loads the pinned catalog chunk, reporting it through `onPinned` at once,
 * then refreshes it from the server. When the chunk fails, the server catalog
 * stands in and the notice says so; when neither loads, the catalog is empty
 * and the notice says that instead. Never rejects.
 */
export async function loadAuthOmpCatalog(
  loadPinned: () => Promise<OmpCatalog>,
  hosted: HostedCatalogLoader,
  onPinned: (pinned: OmpCatalog) => void = () => undefined,
): Promise<{ catalog: OmpCatalog; notice: string | null }> {
  let pinned: OmpCatalog;
  try {
    pinned = await loadPinned();
  } catch {
    const fromServer = await refreshOmpCatalog(emptyCatalog, hosted);
    return { catalog: fromServer, notice: fromServer.providers.length > 0 ? BUNDLED_CATALOG_FALLBACK_NOTICE : CATALOG_UNAVAILABLE_NOTICE };
  }
  onPinned(pinned);
  return { catalog: await refreshOmpCatalog(pinned, hosted), notice: null };
}

/**
 * The auth page's OMP catalog: the pinned chunk at once, then the hosted
 * catalog when it loads. When the chunk fails, the hosted catalog stands in and
 * a notice says so. `onOmpUnavailable` hears only a backend without OMP sign-in
 * (404 or not configured); a transient failure keeps the current catalog.
 */
export function useAuthOmpCatalog(loadCatalog: HostedCatalogLoader, onOmpUnavailable: () => void) {
  const [catalog, setCatalog] = useState<OmpCatalog | null>(loadedPinnedOmpCatalog);
  const [notice, setNotice] = useState<string | null>(null);
  const onOmpUnavailableRef = useRef(onOmpUnavailable);
  useEffect(() => { onOmpUnavailableRef.current = onOmpUnavailable; }, [onOmpUnavailable]);

  useEffect(() => {
    let cancelled = false;
    const hosted = loadCatalog
      ? () => loadCatalog().catch((caught: unknown) => {
        if (isOmpUnavailableError(caught) && !cancelled) onOmpUnavailableRef.current();
        throw caught;
      })
      : null;
    void loadAuthOmpCatalog(loadPinnedOmpCatalog, hosted, (pinned) => {
      if (!cancelled) setCatalog((current) => current ?? pinned);
    }).then((next) => {
      if (cancelled) return;
      setCatalog(next.catalog);
      setNotice(next.notice);
    });
    return () => { cancelled = true; };
  }, [loadCatalog]);

  return { catalog, notice };
}
