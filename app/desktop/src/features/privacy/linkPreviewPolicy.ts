import { useSyncExternalStore } from 'react';

import {
  readPreferenceStorageItem,
  resolvePreferenceStorage,
  writePreferenceStorageItem,
} from '@/features/cloud/preferenceStorage';
import type { CloudContactSummary } from '@/features/cloud/cloudContactTypes';
import type { Message } from '@/kordi-app/types';

/**
 * Per-device setting for link network fetches: preview metadata, preview
 * artwork, and site icons. Loading any of them contacts the linked website.
 */
export type LinkPreviewPreference = 'contacts' | 'everyone' | 'off';

export const DEFAULT_LINK_PREVIEW_PREFERENCE: LinkPreviewPreference = 'contacts';
export const LINK_PREVIEW_PREFERENCE_STORAGE_KEY = 'kordi.link-previews.v1';

const listeners = new Set<() => void>();
let cachedPreference: LinkPreviewPreference | null = null;
let removeStorageListener: (() => void) | null = null;

/** Missing, invalid, and unreadable values all read as the default. */
export function parseLinkPreviewPreference(value: unknown): LinkPreviewPreference {
  return value === 'contacts' || value === 'everyone' || value === 'off'
    ? value
    : DEFAULT_LINK_PREVIEW_PREFERENCE;
}

export function readLinkPreviewPreference(): LinkPreviewPreference {
  if (cachedPreference) return cachedPreference;
  const storage = resolvePreferenceStorage();
  cachedPreference = parseLinkPreviewPreference(
    storage ? readPreferenceStorageItem(storage, LINK_PREVIEW_PREFERENCE_STORAGE_KEY) : null,
  );
  return cachedPreference;
}

function notifyLinkPreviewPreferenceListeners() {
  listeners.forEach((listener) => listener());
}

export function setLinkPreviewPreference(value: LinkPreviewPreference): void {
  cachedPreference = parseLinkPreviewPreference(value);
  const storage = resolvePreferenceStorage();
  if (storage) writePreferenceStorageItem(storage, LINK_PREVIEW_PREFERENCE_STORAGE_KEY, cachedPreference);
  notifyLinkPreviewPreferenceListeners();
}

function installStorageListener() {
  if (removeStorageListener || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  // Other windows write the same key; drop the cache so every window agrees.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LINK_PREVIEW_PREFERENCE_STORAGE_KEY) return;
    cachedPreference = null;
    notifyLinkPreviewPreferenceListeners();
  };
  window.addEventListener('storage', onStorage);
  removeStorageListener = () => window.removeEventListener('storage', onStorage);
}

function subscribeLinkPreviewPreference(listener: () => void) {
  listeners.add(listener);
  installStorageListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      removeStorageListener?.();
      removeStorageListener = null;
    }
  };
}

export function useLinkPreviewPreference(): LinkPreviewPreference {
  // The server snapshot reads the same cache so static rendering sees values
  // set with setLinkPreviewPreference.
  return useSyncExternalStore(
    subscribeLinkPreviewPreference,
    readLinkPreviewPreference,
    readLinkPreviewPreference,
  );
}

export function resetLinkPreviewPreferenceForTests(): void {
  cachedPreference = null;
  notifyLinkPreviewPreferenceListeners();
}

type TrustedLinkPreviewContactRow = Pick<CloudContactSummary, 'accountId' | 'contactKind' | 'targetCloudAgentId'>;

/**
 * Account ids whose links may load previews under the default setting: the
 * signed-in account and the human rows of the server's contacts list for that
 * account. Pass only rows from the contacts response (`serverContacts`), never
 * the merged display list, which also holds realtime hints and optimistic
 * rows. System agents and agent targets never qualify.
 */
export function trustedLinkPreviewHumanIds({
  selfAccountId,
  serverContacts,
}: {
  selfAccountId?: string | null;
  serverContacts: readonly TrustedLinkPreviewContactRow[];
}): ReadonlySet<string> {
  const trusted = new Set<string>();
  const self = selfAccountId?.trim();
  if (self) trusted.add(self);
  for (const row of serverContacts) {
    const accountId = row.accountId?.trim();
    if (!accountId) continue;
    if (row.contactKind?.trim() === 'system_agent') continue;
    if (row.targetCloudAgentId?.trim()) continue;
    trusted.add(accountId);
  }
  return trusted;
}

export type LinkPreviewPolicyMessage = Pick<
  Message,
  'role' | 'senderType' | 'isOwnMessage' | 'senderHumanId' | 'senderIdentityId'
>;

/**
 * The human account behind a message, or null when it can't be resolved.
 * Local and source-scoped identities (`human:local:…`, `human:source:…`)
 * don't name a cloud account.
 */
export function messageSenderHumanId(message: Pick<LinkPreviewPolicyMessage, 'senderHumanId' | 'senderIdentityId'>): string | null {
  const explicit = message.senderHumanId?.trim();
  if (explicit) return explicit;
  const identityId = message.senderIdentityId?.trim() ?? '';
  if (identityId.startsWith('human:')) {
    const humanId = identityId.slice('human:'.length);
    return humanId && !humanId.includes(':') ? humanId : null;
  }
  return identityId.startsWith('acct_') ? identityId : null;
}

/**
 * Decides whether a message may contact the websites it links to. Agent
 * output never qualifies under the default setting, because its links can be
 * chosen by content the agent read.
 */
export function messageAllowsLinkNetwork(
  preference: LinkPreviewPreference,
  message: LinkPreviewPolicyMessage,
  trustedHumanIds: ReadonlySet<string>,
): boolean {
  if (preference === 'off') return false;
  if (preference === 'everyone') return true;
  if (message.senderType === 'agent' || message.role === 'owned-agent' || message.role === 'external-agent') return false;
  if (message.isOwnMessage === true || message.role === 'user') return true;
  const humanId = messageSenderHumanId(message);
  return humanId ? trustedHumanIds.has(humanId) : false;
}
