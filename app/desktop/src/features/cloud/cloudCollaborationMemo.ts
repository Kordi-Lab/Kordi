import { cloudDirectPersonSessionId } from '@/features/collaboration/conversationIds';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

import type { CloudAccount, CloudMessage } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';

export type CloudSelfAgentSessionPartition = {
  hasSessionScopedMessages: boolean;
  messagesBySessionId: ReadonlyMap<string | null, readonly CloudMessage[]>;
};

const selfAgentPartitionCache = new WeakMap<readonly CloudMessage[], CloudSelfAgentSessionPartition>();
const directPersonMessagesCache = new WeakMap<readonly CloudMessage[], Map<string, readonly CloudMessage[]>>();
const groupControlMessageIdsCache = new WeakMap<CloudMessageIndex, ReadonlySet<string>>();
const turnRevisionCache = new WeakMap<
  readonly CloudMessage[],
  WeakMap<Record<string, DesktopChatTurnSnapshot>, string>
>();
const readIdsRevisionCache = new WeakMap<ReadonlySet<string>, string>();

function cleanSessionId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

export function cloudDirectPersonMessagesForPeer(
  account: CloudAccount,
  peerAccountId: string,
  messages: readonly CloudMessage[],
): readonly CloudMessage[] {
  const cacheKey = `${account.accountId}\u0000${peerAccountId}`;
  const cached = directPersonMessagesCache.get(messages)?.get(cacheKey);
  if (cached) return cached;
  const directSessionId = cloudDirectPersonSessionId(account.accountId, peerAccountId);
  const directMessages = messages.filter((message) => {
    const sessionId = cleanSessionId(message.sessionId);
    return !sessionId || sessionId === directSessionId;
  });
  const cache = directPersonMessagesCache.get(messages)
    ?? new Map<string, readonly CloudMessage[]>();
  cache.set(cacheKey, directMessages);
  directPersonMessagesCache.set(messages, cache);
  return directMessages;
}

export function cloudSelfAgentMessagesBySession(
  messages: readonly CloudMessage[],
): CloudSelfAgentSessionPartition {
  const cached = selfAgentPartitionCache.get(messages);
  if (cached) return cached;
  const mutable = new Map<string | null, CloudMessage[]>();
  let hasSessionScopedMessages = false;
  for (const message of messages) {
    const sessionId = cleanSessionId(message.sessionId);
    if (sessionId) hasSessionScopedMessages = true;
    const bucket = mutable.get(sessionId) ?? [];
    bucket.push(message);
    mutable.set(sessionId, bucket);
  }
  const messagesBySessionId = new Map<string | null, readonly CloudMessage[]>(mutable);
  const partition = { hasSessionScopedMessages, messagesBySessionId };
  selfAgentPartitionCache.set(messages, partition);
  return partition;
}

export function cloudGroupControlMessageIds(index: CloudMessageIndex): ReadonlySet<string> {
  const cached = groupControlMessageIdsCache.get(index);
  if (cached) return cached;
  const ids = new Set(index.groupRows.map((row) => row.wire.messageId));
  groupControlMessageIdsCache.set(index, ids);
  return ids;
}

export function cloudTurnRevision(
  messages: readonly CloudMessage[],
  localAgentTurnsByRequestId: Record<string, DesktopChatTurnSnapshot>,
): string {
  let byTurnStore = turnRevisionCache.get(messages);
  const cached = byTurnStore?.get(localAgentTurnsByRequestId);
  if (cached !== undefined) return cached;
  const revision = messages.flatMap((message) => {
    const turn = localAgentTurnsByRequestId[message.messageId];
    return turn
      ? [`${message.messageId}:${turn.id}:${turn.status}:${turn.completed}:${turn.assistantText.length}:${turn.error ?? ''}`]
      : [];
  }).join(',');
  byTurnStore ??= new WeakMap();
  byTurnStore.set(localAgentTurnsByRequestId, revision);
  turnRevisionCache.set(messages, byTurnStore);
  return revision;
}

export function cloudReadIdsRevision(readIds: ReadonlySet<string>): string {
  const cached = readIdsRevisionCache.get(readIds);
  if (cached !== undefined) return cached;
  const revision = [...readIds].sort().join(',');
  readIdsRevisionCache.set(readIds, revision);
  return revision;
}
