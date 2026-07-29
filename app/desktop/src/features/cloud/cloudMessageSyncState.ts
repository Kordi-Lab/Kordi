import type {
  CloudAccount,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import {
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  parseCloudGroupControl,
} from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { mergeCloudMessageMonotonicState } from './cloudDiffSync';

export type CloudUnreadReadinessStatus = 'pending' | 'ready' | 'error';

export type CloudUnreadReadinessSnapshot = {
  status: CloudUnreadReadinessStatus;
  contextKey: string | null;
};

export function cloudBootstrapPeerIds(
  account: CloudAccount | null | undefined,
  contactPeerIds: string[],
  groupParticipantPeerIds: string[],
  requests: Parameters<
    typeof cloudGroupPeerIdsFromContactsAndRequests
  >[0]['requests'] = [],
): string[] {
  const messagePeerIds = [...new Set([...contactPeerIds, ...groupParticipantPeerIds])];
  if (!account) return messagePeerIds;
  const selfPeerId = account.accountId.trim();
  const expandedPeerIds = cloudGroupPeerIdsFromContactsAndRequests({
    accountId: account.accountId,
    contactPeerIds: messagePeerIds,
    requests,
  });
  return [...new Set([selfPeerId, ...expandedPeerIds].filter(Boolean))].sort();
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function cloudMessageAttachmentsEqual(
  left: CloudMessage['attachments'] = [],
  right: CloudMessage['attachments'] = [],
): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((attachment, index) => {
    const other = (right ?? [])[index];
    return Boolean(other)
      && attachment.attachmentId === other.attachmentId
      && attachment.name === other.name
      && attachment.kind === other.kind
      && (attachment.mimeType ?? null) === (other.mimeType ?? null)
      && (attachment.sizeBytes ?? null) === (other.sizeBytes ?? null)
      && (attachment.localPath ?? null) === (other.localPath ?? null);
  });
}

function cloudMessagesEqual(message: CloudMessage, other: CloudMessage | undefined): boolean {
  if (!other) return false;
  return message.messageId === other.messageId
    && message.fromAccountId === other.fromAccountId
    && message.toAccountId === other.toAccountId
    && message.body === other.body
    && message.createdAt === other.createdAt
    && message.deliveredAt === other.deliveredAt
    && message.readAt === other.readAt
    && message.direction === other.direction
    && (message.sessionId ?? null) === (other.sessionId ?? null)
    && cloudMessageAttachmentsEqual(message.attachments, other.attachments);
}

function cloudMessageListsEqual(left: CloudMessage[] = [], right: CloudMessage[] = []): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => cloudMessagesEqual(message, right[index]));
}

export function cloudMessagesByPeerEqual(
  left: Record<string, CloudMessage[]>,
  right: Record<string, CloudMessage[]>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => (
    key === rightKeys[index] && cloudMessageListsEqual(left[key], right[key])
  ));
}

export function mergeCloudMessagesByPeerSnapshot(
  current: Record<string, CloudMessage[]>,
  incoming: Record<string, CloudMessage[]>,
): Record<string, CloudMessage[]> {
  const peerIds = uniqueSortedPeerIds([...Object.keys(current), ...Object.keys(incoming)]);
  const merged: Record<string, CloudMessage[]> = {};
  let changed = peerIds.length !== Object.keys(current).length;
  for (const peerId of peerIds) {
    const currentMessages = current[peerId] ?? [];
    const byMessageId = new Map<string, CloudMessage>();
    for (const message of currentMessages) byMessageId.set(message.messageId, message);
    for (const message of incoming[peerId] ?? []) {
      const previous = byMessageId.get(message.messageId);
      if (!previous) {
        byMessageId.set(message.messageId, message);
        continue;
      }
      const candidate = mergeCloudMessageMonotonicState(previous, message);
      byMessageId.set(
        message.messageId,
        cloudMessagesEqual(previous, candidate) ? previous : candidate,
      );
    }
    const messages = [...byMessageId.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (messages.length > 0) {
      const unchanged = cloudMessageListsEqual(currentMessages, messages);
      merged[peerId] = unchanged ? currentMessages : messages;
      if (!unchanged) changed = true;
    }
  }
  return changed ? merged : current;
}

export function markCloudMessagesReadLocally(
  current: Record<string, CloudMessage[]>,
  accountId: string,
  targets: {
    peerIds?: string[];
    sessionIds?: string[];
    groupRowByWireMessageId?: ReadonlyMap<string, IndexedCloudGroupRow>;
  },
  readAt: string = new Date().toISOString(),
): Record<string, CloudMessage[]> {
  const localAccountId = cleanText(accountId);
  const peerIds = new Set((targets.peerIds ?? []).map(cleanText).filter(Boolean));
  const sessionIds = new Set((targets.sessionIds ?? []).map(cleanText).filter(Boolean));
  if (!localAccountId || (peerIds.size === 0 && sessionIds.size === 0)) return current;

  let changed = false;
  const next: Record<string, CloudMessage[]> = {};
  for (const [peerId, messages] of Object.entries(current)) {
    let nextMessages: CloudMessage[] | null = null;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.toAccountId !== localAccountId || message.direction !== 'incoming' || message.readAt) {
        continue;
      }
      const peerMatches = peerIds.has(peerId) || peerIds.has(message.fromAccountId);
      const indexedGroupId = targets.groupRowByWireMessageId
        ?.get(message.messageId)
        ?.envelope.groupId;
      const messageSessionId = peerMatches || sessionIds.size === 0
        ? ''
        : cleanText(message.sessionId)
          || cleanText(indexedGroupId)
          || (targets.groupRowByWireMessageId
            ? ''
            : cleanText(parseCloudGroupControl(message.body)?.groupId));
      const sessionMatches = Boolean(messageSessionId && sessionIds.has(messageSessionId));
      if (!peerMatches && !sessionMatches) continue;
      changed = true;
      nextMessages ??= messages.slice();
      nextMessages[index] = { ...message, readAt };
    }
    next[peerId] = nextMessages ?? messages;
  }
  return changed ? next : current;
}

export const CLOUD_MESSAGE_DISCOVERY_MAX_PASSES = 50;
export const CLOUD_FOCUS_REFRESH_THROTTLE_MS = 5000;
export const CLOUD_FOCUS_REFRESH_DELAY_MS = 500;

export function shouldRefreshCloudForVisibility(visibilityState: DocumentVisibilityState) {
  return visibilityState === 'visible';
}

export function shouldRunCloudFocusRefresh(
  nowMs: number,
  lastRefreshAtMs: number,
  throttleMs = CLOUD_FOCUS_REFRESH_THROTTLE_MS,
) {
  return lastRefreshAtMs <= 0 || nowMs - lastRefreshAtMs >= throttleMs;
}

export function cloudSessionForksByIdEqual(
  left: Record<string, CloudSessionForkSummary>,
  right: Record<string, CloudSessionForkSummary>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index]) return false;
    const leftFork = left[key];
    const rightFork = right[key];
    if (
      leftFork.forkSessionId !== rightFork.forkSessionId
      || leftFork.parentSessionId !== rightFork.parentSessionId
      || leftFork.parentMessageId !== rightFork.parentMessageId
      || leftFork.createdByAccountId !== rightFork.createdByAccountId
      || leftFork.createdAt !== rightFork.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function uniqueSortedPeerIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

function peerIdListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function cloudUnreadReadinessContextKey(
  accountId: string,
  generation: number,
  peerKey: string,
) {
  return JSON.stringify([accountId.trim(), generation, peerKey]);
}

export function cloudAccountGenerationKey(accountId: string, generation: number) {
  return JSON.stringify([accountId.trim(), generation]);
}

export function transitionCloudUnreadReadiness(
  current: CloudUnreadReadinessSnapshot,
  status: CloudUnreadReadinessStatus,
  contextKey: string,
): CloudUnreadReadinessSnapshot {
  if (status !== 'ready' && current.status === 'ready' && current.contextKey === contextKey) {
    return current;
  }
  if (current.status === status && current.contextKey === contextKey) return current;
  return { status, contextKey };
}

export function cloudMessagesAuthoritativeForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
}): boolean {
  if (!accountId) return true;
  if (!contactsSettled) return false;
  return readiness.status === 'ready'
    && readiness.contextKey === cloudUnreadReadinessContextKey(accountId, generation, peerKey);
}

export function cloudUnreadReadyForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
  publishedContextKey,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
  publishedContextKey: string | null;
}): boolean {
  return cloudUnreadStatusForContext({
    accountId,
    contactsSettled,
    generation,
    peerKey,
    readiness,
    publishedContextKey,
  }) === 'ready';
}

export function cloudUnreadStatusForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
  publishedContextKey,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
  publishedContextKey: string | null;
}): CloudUnreadReadinessStatus {
  if (!accountId) return 'ready';
  if (!contactsSettled) return 'pending';
  const contextKey = cloudUnreadReadinessContextKey(accountId, generation, peerKey);
  if (readiness.contextKey !== contextKey) return 'pending';
  if (readiness.status !== 'ready') return readiness.status;
  return publishedContextKey === contextKey ? 'ready' : 'pending';
}

export async function loadCloudMessagesByPeerUntilStable({
  accountId,
  initialPeerIds,
  existingMessagesByPeer,
  listMessages,
  maxPasses = CLOUD_MESSAGE_DISCOVERY_MAX_PASSES,
}: {
  accountId: string;
  initialPeerIds: string[];
  existingMessagesByPeer: Record<string, CloudMessage[]>;
  listMessages: (peerId: string) => Promise<CloudMessage[]>;
  maxPasses?: number;
}): Promise<{
  messagesByPeer: Record<string, CloudMessage[]>;
  peerIds: string[];
  complete: boolean;
}> {
  const byPeer: Record<string, CloudMessage[]> = {};
  let peerIds = uniqueSortedPeerIds(initialPeerIds);
  let hadError = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const missingPeerIds = peerIds.filter((peerId) => !(peerId in byPeer));
    if (missingPeerIds.length === 0) {
      return { messagesByPeer: byPeer, peerIds, complete: !hadError };
    }

    const entries = await Promise.all(missingPeerIds.map(async (peerId) => {
      try {
        return [peerId, await listMessages(peerId)] as const;
      } catch {
        hadError = true;
        return [peerId, existingMessagesByPeer[peerId] ?? []] as const;
      }
    }));
    for (const [peerId, messages] of entries) byPeer[peerId] = messages;

    const expandedPeerIds = uniqueSortedPeerIds(cloudGroupPeerIdsFromMessages({
      accountId,
      contactPeerIds: peerIds,
      messages: Object.values(byPeer).flat(),
    }));
    if (peerIdListsEqual(expandedPeerIds, peerIds)) {
      return { messagesByPeer: byPeer, peerIds, complete: !hadError };
    }
    peerIds = expandedPeerIds;
  }

  return { messagesByPeer: byPeer, peerIds, complete: false };
}

export function createAccountScopedSingleFlight() {
  const inFlightByAccount = new Map<string, Promise<void>>();
  return (accountId: string, task: () => Promise<void>): Promise<void> => {
    const key = accountId.trim();
    const existing = inFlightByAccount.get(key);
    if (existing) return existing;

    let tracked: Promise<void>;
    try {
      tracked = task().finally(() => {
        if (inFlightByAccount.get(key) === tracked) inFlightByAccount.delete(key);
      });
    } catch (error) {
      return Promise.resolve().then(() => {
        throw error;
      });
    }
    inFlightByAccount.set(key, tracked);
    return tracked;
  };
}
