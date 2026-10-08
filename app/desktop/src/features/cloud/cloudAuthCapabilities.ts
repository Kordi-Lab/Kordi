import { useCallback, useEffect, useState } from 'react';

import type { CloudAuthCapabilities, CloudAuthClient } from './authClient';

type CapabilitiesSource = Pick<CloudAuthClient, 'capabilities'>;

// One fetch per key per app load. Callers using the default client share the
// API base URL as the key, so the sign-in screen and account settings make one
// request; other clients are cached per instance. A failed fetch is dropped so
// the next caller retries.
const capabilitiesByKey = new Map<string, Promise<CloudAuthCapabilities>>();
const capabilitiesByClient = new WeakMap<CapabilitiesSource, Promise<CloudAuthCapabilities>>();

export function loadCloudAuthCapabilities(client: CapabilitiesSource, key?: string): Promise<CloudAuthCapabilities> {
  const cached = key === undefined ? capabilitiesByClient.get(client) : capabilitiesByKey.get(key);
  if (cached) return cached;
  const pending = client.capabilities();
  if (key === undefined) capabilitiesByClient.set(client, pending);
  else capabilitiesByKey.set(key, pending);
  pending.catch(() => {
    if (key === undefined) {
      if (capabilitiesByClient.get(client) === pending) capabilitiesByClient.delete(client);
    } else if (capabilitiesByKey.get(key) === pending) {
      capabilitiesByKey.delete(key);
    }
  });
  return pending;
}

export function clearCloudAuthCapabilitiesCacheForTests(): void {
  capabilitiesByKey.clear();
}

export type CloudAuthCapabilitiesStatus = 'loading' | 'loaded' | 'failed';

export type CloudAuthCapabilitiesState = {
  status: CloudAuthCapabilitiesStatus;
  /** Null unless `status` is `loaded`. */
  capabilities: CloudAuthCapabilities | null;
  /** Fetches again; a failed fetch is never cached, so this reaches the server. */
  refetch: () => void;
};

type SettledCapabilities = {
  client: CapabilitiesSource;
  key: string | undefined;
  attempt: number;
  status: 'loaded' | 'failed';
  capabilities: CloudAuthCapabilities | null;
};

/** Capabilities from the shared fetch, with loading and failed states kept apart. */
export function useCloudAuthCapabilitiesState(client: CapabilitiesSource | null, key?: string): CloudAuthCapabilitiesState {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<SettledCapabilities | null>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    loadCloudAuthCapabilities(client, key).then(
      (value) => { if (!cancelled) setSettled({ client, key, attempt, status: 'loaded', capabilities: value }); },
      () => { if (!cancelled) setSettled({ client, key, attempt, status: 'failed', capabilities: null }); },
    );
    return () => { cancelled = true; };
  }, [attempt, client, key]);
  const refetch = useCallback(() => setAttempt((value) => value + 1), []);
  const current = client && settled && settled.client === client && settled.key === key && settled.attempt === attempt
    ? settled
    : null;
  return {
    status: current?.status ?? 'loading',
    capabilities: current?.capabilities ?? null,
    refetch,
  };
}

/** Capabilities from the shared fetch; null until loaded or when the fetch fails. */
export function useCloudAuthCapabilities(client: CapabilitiesSource | null, key?: string): CloudAuthCapabilities | null {
  return useCloudAuthCapabilitiesState(client, key).capabilities;
}
