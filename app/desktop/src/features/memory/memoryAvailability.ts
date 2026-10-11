import { useSyncExternalStore } from 'react';

import { memorySectionAvailable } from './memoryClient';

const listeners = new Set<() => void>();
let serverMemoryVersion: number | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): boolean {
  return memorySectionAvailable(serverMemoryVersion);
}

/**
 * Records the `memoryVersion` the signed-in server reports, so every
 * conversation header can show or hide its Memory tab without prop drilling.
 */
export function publishMemoryVersion(memoryVersion: number | null | undefined) {
  const next = memoryVersion ?? null;
  if (next === serverMemoryVersion) return;
  serverMemoryVersion = next;
  listeners.forEach((listener) => listener());
}

/** Whether conversations show their Memory tab: the same gate as the settings Memory section. */
export function useMemoryTabAvailable(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
