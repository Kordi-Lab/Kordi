import { useSyncExternalStore } from 'react';

// The server reports `content_removal_version` on sync and bootstrap. Version 1
// means it removes stored text and files after a delete for everyone. A
// missing or unknown value means 0, so the app shows the conservative copy.
type ContentRemovalCapability = {
  accountId: string | null;
  version: number;
};

let current: ContentRemovalCapability = { accountId: null, version: 0 };
const listeners = new Set<() => void>();

function publish(next: ContentRemovalCapability): void {
  if (next.accountId === current.accountId && next.version === current.version) return;
  current = next;
  listeners.forEach((listener) => listener());
}

export function normalizeContentRemovalVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function setServerContentRemovalVersion(
  value: unknown,
  accountId: string | null = current.accountId,
): void {
  publish({ accountId, version: normalizeContentRemovalVersion(value) });
}

export function resetServerContentRemovalVersion(accountId: string | null = null): void {
  publish({ accountId, version: 0 });
}

/** Forgets the reported version when a different account becomes active. */
export function noteContentRemovalAccount(accountId: string | null): void {
  if (accountId !== current.accountId) resetServerContentRemovalVersion(accountId);
}

export function serverContentRemovalVersion(): number {
  return current.version;
}

export function subscribeServerContentRemovalVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useServerContentRemovalVersion(): number {
  return useSyncExternalStore(
    subscribeServerContentRemovalVersion,
    serverContentRemovalVersion,
    serverContentRemovalVersion,
  );
}
