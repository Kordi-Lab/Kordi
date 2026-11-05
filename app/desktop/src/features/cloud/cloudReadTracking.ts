import {
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  cloudSystemAgentSessionId,
  isCloudSystemAgentSessionId,
} from '@/features/collaboration/conversationIds';

import type { CloudAccount, CloudMessage } from './authClient';
import { isTerminalCloudAgentResponse } from './cloudAgentMessages';
import { cloudDirectPersonMessagesForPeer } from './cloudCollaborationMemo';
import type { CloudMessageIndex } from './cloudMessageIndex';

export type CloudDirectReadTarget = {
  peerId: string;
  sessionId: string;
  messageIds: string[];
  observedSequence: number;
};

// A built-in system agent chat (such as Kordi Support) is a direct
// conversation with the agent owner, scoped to its own session instead of the
// person-to-person session. Resolve the owner and that session.
function systemAgentReadScope(
  accountId: string,
  activeId: string,
  index: CloudMessageIndex,
): { peerId: string; sessionId: string; messages: readonly CloudMessage[] } | null {
  const sessionId = cloudSessionIdFromConversationId(activeId)
    ?? (isCloudSystemAgentSessionId(activeId) ? activeId.trim() : null);
  if (!sessionId || !isCloudSystemAgentSessionId(sessionId)) return null;
  // Each person has their own session with a system agent; never read another's.
  if (!sessionId.startsWith(`${cloudSystemAgentSessionId(accountId, '')}`)) return null;
  const messages = index.bySessionId.get(sessionId) ?? [];
  const peerId = cloudPeerAccountIdFromConversationId(activeId)
    ?? messages
      .map(message => (message.fromAccountId === accountId ? message.toAccountId : message.fromAccountId))
      .find(peer => Boolean(peer) && peer !== accountId)
    ?? null;
  return peerId ? { peerId, sessionId, messages } : null;
}

function directPersonReadScope(
  account: CloudAccount,
  activeId: string,
  index: CloudMessageIndex,
): { peerId: string; sessionId: string; messages: readonly CloudMessage[] } | null {
  const peerId = cloudConversationKindFromConversationId(activeId) === 'person'
    ? cloudPeerAccountIdFromConversationId(activeId)
    : [...index.byPeerId.keys()].find(peer => (
        cloudDirectPersonSessionId(account.accountId, peer) === activeId
      ));
  if (!peerId) return null;
  const sessionId = cloudDirectPersonSessionId(account.accountId, peerId);
  const explicitSessionId = cloudSessionIdFromConversationId(activeId);
  if (explicitSessionId && explicitSessionId !== sessionId) return null;
  return {
    peerId,
    sessionId,
    messages: cloudDirectPersonMessagesForPeer(account, peerId, index.byPeerId.get(peerId) ?? []),
  };
}

// Messages in the open direct conversation that still need a read receipt.
// The hook re-evaluates this whenever new messages arrive, so a reply that
// lands while the chat is visible is acknowledged right away.
export function cloudDirectReadTarget(
  account: CloudAccount,
  activeId: string,
  index: CloudMessageIndex,
): CloudDirectReadTarget | null {
  if (index.sourceAccountId !== account.accountId) return null;
  const scope = systemAgentReadScope(account.accountId, activeId, index)
    ?? directPersonReadScope(account, activeId, index);
  if (!scope || scope.peerId === account.accountId) return null;
  const { peerId, sessionId } = scope;
  const unreadMessages = scope.messages.filter(message => (
    !index.groupRowByWireMessageId.has(message.messageId)
    && ((message.fromAccountId === peerId
      && message.toAccountId === account.accountId
      && message.direction === 'incoming'
      && !message.readAt)
      // The owner's agent is authored by the owner on the wire, but its
      // completed reply still needs to be read by that owner. Outgoing
      // readAt records the peer's receipt and cannot gate this read.
      || (message.fromAccountId === account.accountId
        && (message.toAccountId === peerId || message.toAccountId === account.accountId)
        && isTerminalCloudAgentResponse(message.body)))
  ));
  let observedSequence = 0;
  const messageIds = unreadMessages.map(({ messageId, conversationSequence }) => {
    if (Number.isSafeInteger(conversationSequence)) {
      observedSequence = Math.max(observedSequence, conversationSequence!);
    }
    return messageId;
  });
  return messageIds.length ? { peerId, sessionId, messageIds, observedSequence } : null;
}

export function rollbackReadInboundMessageIds(
  current: Record<string, Set<string>>,
  peerId: string,
  messageIds: readonly string[],
): Record<string, Set<string>> {
  const existing = current[peerId];
  if (!existing) return current;
  const next = new Set(existing);
  for (const messageId of messageIds) next.delete(messageId);
  if (next.size === existing.size) return current;
  const result = { ...current };
  if (next.size > 0) result[peerId] = next;
  else delete result[peerId];
  return result;
}

export function addReadInboundMessageIds(
  current: Record<string, Set<string>>,
  peerId: string,
  messageIds: readonly string[],
): Record<string, Set<string>> {
  const existing = current[peerId] ?? new Set<string>();
  const next = new Set(existing);
  for (const messageId of messageIds) next.add(messageId);
  return next.size === existing.size ? current : { ...current, [peerId]: next };
}

// Highest server sequence the renderer holds per group. The cached chat head
// can lag replies this Mac published itself, and those replies are counted
// as unread until the read cursor covers them.
export function cloudGroupObservedSequences(
  groupRows: readonly { wire: { conversationSequence?: number | null }; envelope: { groupId: string } }[],
  sessionIds: readonly string[],
): Record<string, number> {
  const wanted = new Set(sessionIds);
  const sequences: Record<string, number> = {};
  for (const { wire, envelope } of groupRows) {
    const sequence = wire.conversationSequence;
    if (!wanted.has(envelope.groupId) || !Number.isSafeInteger(sequence) || sequence! <= 0) continue;
    sequences[envelope.groupId] = Math.max(sequences[envelope.groupId] ?? 0, sequence!);
  }
  return sequences;
}
