// Blocked-account messages the viewer chose to show. The choice lasts for
// the app session, and lives outside React so a row that scrolls out of the
// virtual transcript and back stays revealed.

import { useSyncExternalStore } from 'react';

let revealedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot() {
  return revealedKeys;
}

export function revealedBlockedMessageKeys(): ReadonlySet<string> {
  return revealedKeys;
}

export function revealBlockedMessage(key: string) {
  const id = key.trim();
  if (!id || revealedKeys.has(id)) return;
  revealedKeys = new Set([...revealedKeys, id]);
  for (const listener of listeners) listener();
}

export function useRevealedBlockedMessageKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function __resetRevealedBlockedMessagesForTests() {
  revealedKeys = new Set();
}
