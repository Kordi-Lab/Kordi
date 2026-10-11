import { useEffect, useMemo, useRef, useState } from 'react';

import {
  mirroredSessionRequestRouteRecords,
  type SessionRuntimeRouteRecord,
} from '@/features/cloud/cloudAgentRuntimeRequestRoutes';
import {
  fetchCanonicalSessionRequestRoutes,
  type CanonicalSessionRequestRoute,
} from '@/lib/desktopCanonicalSessionRoutes';

const REFRESH_DELAY_MS = 250;
const EMPTY_RECORDS: SessionRuntimeRouteRecord[] = [];

type Snapshot = { accountId: string; rows: CanonicalSessionRequestRoute[]; key: string };

/**
 * The latest routed request of every session, read from the local mirror.
 * Loaded transcript pages and the Cloud bootstrap hold only part of a
 * session's history, so this keeps a restored route independent of them. It
 * refreshes when the account changes and shortly after the canonical store
 * changes, which covers a reload and every send.
 */
export function useMirroredSessionRequestRoutes(
  accountId: string | null | undefined,
  canonicalMessages: unknown,
  fetchRoutes: () => Promise<CanonicalSessionRequestRoute[]> = fetchCanonicalSessionRequestRoutes,
): SessionRuntimeRouteRecord[] {
  const normalizedAccountId = accountId?.trim() ?? '';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const currentAccountIdRef = useRef(normalizedAccountId);
  const loadedAccountIdRef = useRef<string | null>(null);
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    currentAccountIdRef.current = normalizedAccountId;
    if (!normalizedAccountId) return;
    const load = () => {
      pendingRefreshRef.current = null;
      void fetchRoutes().then((rows) => {
        // A result is kept for the account it was read for only.
        if (currentAccountIdRef.current !== normalizedAccountId) return;
        const key = JSON.stringify(rows);
        setSnapshot((current) => (
          current?.accountId === normalizedAccountId && current.key === key
            ? current
            : { accountId: normalizedAccountId, rows, key }
        ));
      }, () => undefined);
    };
    // A new account loads at once; later store changes share one refresh.
    if (loadedAccountIdRef.current !== normalizedAccountId) {
      loadedAccountIdRef.current = normalizedAccountId;
      load();
      return;
    }
    pendingRefreshRef.current ??= setTimeout(load, REFRESH_DELAY_MS);
  }, [canonicalMessages, fetchRoutes, normalizedAccountId]);

  useEffect(() => () => {
    if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
    pendingRefreshRef.current = null;
  }, []);

  return useMemo(() => (
    snapshot && snapshot.accountId === normalizedAccountId
      ? mirroredSessionRequestRouteRecords(snapshot.rows)
      : EMPTY_RECORDS
  ), [normalizedAccountId, snapshot]);
}
