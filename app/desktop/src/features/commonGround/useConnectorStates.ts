import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectorProviderId, ConnectorStatus } from '@/features/connectors/connectorsModel';
import { CONNECTORS_LINK_PROVIDER_IDS } from '@/features/connectors/connectorsSettingsLink';
import type { CgConnectorsAccess } from './host';

/** While settings may be connecting one, the list is checked this often. */
const SETUP_POLL_MS = 5_000;

export type CgConnectorStates = Partial<Record<ConnectorProviderId, ConnectorStatus>>;

/** Connection state of each connector; refreshed on focus and while a set-up is open. */
export function useConnectorStates(access: CgConnectorsAccess | null) {
  const [states, setStates] = useState<CgConnectorStates | null>(access ? null : {});
  const [watching, setWatching] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!access) return;
    try {
      const { states: list } = await access.client.list();
      if (alive.current) setStates(Object.fromEntries(list.map((state) => [state.providerId, state.status])));
    } catch {
      if (alive.current) setStates((current) => current ?? {});
    }
  }, [access]);
  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => { if (alive.current) void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => { void refresh(); }, SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, watching]);
  const connectedCount = CONNECTORS_LINK_PROVIDER_IDS.filter((id) => states?.[id] === 'connected').length;
  return { states, connectedCount, refresh, watch: () => setWatching(true) };
}

/** Connected connectors whose switch is on. */
export function includedConnectors(picked: string[], states: CgConnectorStates | null): string[] {
  return CONNECTORS_LINK_PROVIDER_IDS.filter((id) => picked.includes(id) && states?.[id] === 'connected');
}
