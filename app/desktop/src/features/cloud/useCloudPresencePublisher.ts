import { useEffect, useMemo, useRef } from 'react';

import type { CloudAccount, CloudAuthClient } from './authClient';
import { defaultCloudAuthClient } from './authClient';
import { loadSession } from './session';

export const CLOUD_PRESENCE_HEARTBEAT_MS = 10_000;
export type PresenceOfflineEventKind = 'pagehide' | 'beforeunload' | 'logout' | 'react-cleanup';

export function shouldPublishPresenceOfflineForEvent(kind: PresenceOfflineEventKind): boolean {
  return kind === 'pagehide' || kind === 'beforeunload' || kind === 'logout';
}

async function publishWithSession(client: CloudAuthClient, kind: 'online' | 'heartbeat' | 'offline') {
  const session = await loadSession();
  if (!session?.token) return;
  if (kind === 'online') await client.publishPresenceOnline(session.token);
  else if (kind === 'heartbeat') await client.publishPresenceHeartbeat(session.token);
  else await client.publishPresenceOffline(session.token);
}

export function publishPresenceOffline(client: CloudAuthClient = defaultCloudAuthClient()) {
  return publishWithSession(client, 'offline').catch(() => undefined);
}

export function useCloudPresencePublisher(account: CloudAccount | null, providedClient?: CloudAuthClient) {
  const client = useMemo(() => providedClient ?? defaultCloudAuthClient(), [providedClient]);
  const sessionTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!account?.accountId || typeof window === 'undefined') return;
    let cancelled = false;
    void loadSession().then((session) => {
      if (cancelled) return;
      sessionTokenRef.current = session?.token ?? null;
    }).catch(() => undefined);
    void publishWithSession(client, 'online').catch(() => undefined);
    const interval = window.setInterval(() => {
      if (!cancelled) void publishWithSession(client, 'heartbeat').catch(() => undefined);
    }, CLOUD_PRESENCE_HEARTBEAT_MS);
    const publishOffline = () => {
      const token = sessionTokenRef.current;
      if (token) void client.publishPresenceOffline(token).catch(() => undefined);
      else void publishPresenceOffline(client);
    };
    window.addEventListener('pagehide', publishOffline);
    window.addEventListener('beforeunload', publishOffline);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('pagehide', publishOffline);
      window.removeEventListener('beforeunload', publishOffline);
    };
  }, [account?.accountId, client]);
}
