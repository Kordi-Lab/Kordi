import type { CloudPresenceAccount, CloudPresenceContactsResponse, CloudPresenceStatus } from './authClient';

export type CloudPresenceStore = Record<string, CloudPresenceAccount>;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePresenceStatus(value: unknown): CloudPresenceStatus {
  return cleanText(value).toLowerCase() === 'online' ? 'online' : 'offline';
}

export function applyPresenceSnapshot(current: CloudPresenceStore, response: CloudPresenceContactsResponse): CloudPresenceStore {
  const next = { ...current };
  for (const account of response.accounts) {
    const accountId = cleanText(account.accountId);
    if (!accountId) continue;
    next[accountId] = {
      accountId,
      status: normalizePresenceStatus(account.status),
      updatedAt: cleanText(account.updatedAt) || new Date().toISOString(),
    };
  }
  return next;
}

export function mergePresenceEvent(current: CloudPresenceStore, event: CloudPresenceAccount): CloudPresenceStore {
  const accountId = cleanText(event.accountId);
  if (!accountId) return current;
  return {
    ...current,
    [accountId]: {
      accountId,
      status: normalizePresenceStatus(event.status),
      updatedAt: cleanText(event.updatedAt) || new Date().toISOString(),
    },
  };
}

export function presenceStatusForAccount(store: CloudPresenceStore, accountId?: string | null): CloudPresenceStatus {
  const id = cleanText(accountId);
  if (!id) return 'offline';
  return store[id]?.status ?? 'offline';
}

export function shouldRefreshPresenceForWsSubject(subject: string): boolean {
  return subject.startsWith('kordi.events.presence.account.');
}

export function cloudPresenceChangedFromWsPayload(payload: unknown): CloudPresenceAccount | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const accountId = cleanText(record.account_id ?? record.accountId);
  if (!accountId) return null;
  return {
    accountId,
    status: normalizePresenceStatus(record.status),
    updatedAt: cleanText(record.occurred_at ?? record.updatedAt) || new Date().toISOString(),
  };
}
