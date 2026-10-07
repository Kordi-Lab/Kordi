import { useEffect, useState } from 'react';

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

/** Capabilities from the shared fetch; null until loaded or when the fetch fails. */
export function useCloudAuthCapabilities(client: CapabilitiesSource | null, key?: string): CloudAuthCapabilities | null {
  const [capabilities, setCapabilities] = useState<CloudAuthCapabilities | null>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    loadCloudAuthCapabilities(client, key)
      .then((value) => { if (!cancelled) setCapabilities(value); })
      .catch(() => { if (!cancelled) setCapabilities(null); });
    return () => { cancelled = true; };
  }, [client, key]);
  return client ? capabilities : null;
}
