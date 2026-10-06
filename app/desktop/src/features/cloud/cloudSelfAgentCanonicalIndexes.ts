import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudSessionForkSummary } from './authClient';
import type { CloudGroupReadCursor } from './cloudGroupMessages';
import type { CloudSelfAgentRestoreMessage } from './cloudSelfAgentRestoreMessage';
import type { CloudSelfAgentSyncLedger } from './cloudSelfAgentSyncLedger';

const clean = (value?: string | null) => (value ?? '').trim();

export function cloudSelfAgentSessionsNeedingReplyRecovery(state: CanonicalSessionState, ledger: CloudSelfAgentSyncLedger) {
  const messagesById = new Map(state.messages.map((message) => [message.id, message]));
  const requestsByWireId = new Map<string, CanonicalSessionState['messages'][number]>();
  for (const message of state.messages) {
    if (message.senderRole !== 'user') continue;
    const content = message.content as Record<string, unknown> | null;
    const aliases = [ledger[message.id]?.cloudMessageId,
      message.sourceTransport === 'cloud-self-agent' ? message.sourceEventId : null,
      typeof content?.desktopEntryId === 'string' ? content.desktopEntryId : null];
    for (const alias of aliases) {
      if (!alias) continue;
      const key = `${message.sessionId}:${alias}`;
      if (requestsByWireId.get(key)?.sourceTransport === 'desktop-chat-ui' && message.sourceTransport !== 'desktop-chat-ui') continue;
      requestsByWireId.set(key, message);
    }
  }
  return new Set(state.messages.flatMap((message) => {
    if (message.sourceTransport !== 'cloud-self-agent' || message.senderRole !== 'owned-agent') return [];
    const content = message.content as Record<string, unknown> | null;
    const wireId = typeof content?.cloudRequestMessageId === 'string' ? content.cloudRequestMessageId : null;
    if (!wireId) return [];
    const knownParent = messagesById.get(message.parentMessageId ?? '');
    const request = requestsByWireId.get(`${message.sessionId}:${wireId}`)
      ?? (knownParent?.senderRole === 'user' && knownParent.sessionId === message.sessionId ? knownParent : null);
    return request && (message.parentMessageId !== request.id || message.createdAtMs !== request.createdAtMs + 1)
      ? [message.sessionId] : [];
  }));
}

export function durableTerminalRequestIds(
  messages: readonly CloudSelfAgentRestoreMessage[],
  durableSourceEventIds?: ReadonlySet<string>,
) {
  return new Set(messages.flatMap((message) => (
    durableSourceEventIds?.has(message.message.messageId)
    && message.responseRequestId
    && !['sending', 'queued', 'processing'].includes(message.responseDeliveryState ?? 'complete')
      ? [message.responseRequestId]
      : []
  )));
}

export function cloudGroupReadCursorsBySessionId(
  canonicalState?: CanonicalSessionState | null,
): Record<string, CloudGroupReadCursor> {
  if (!canonicalState) return {};
  const rawMessageById = new Map(canonicalState.messages.map((message) => [message.id, message]));
  const cursors: Record<string, CloudGroupReadCursor> = {};
  for (const participant of canonicalState.participants) {
    if (participant.role !== 'self') continue;
    if (canonicalState.profile.humanIdentityId && participant.identityId !== canonicalState.profile.humanIdentityId) continue;
    const lastReadMessageId = clean(participant.lastReadMessageId);
    if (!lastReadMessageId) continue;
    const lastReadMessage = rawMessageById.get(lastReadMessageId);
    cursors[participant.sessionId] = {
      lastReadMessageId,
      lastReadCreatedAtMs: lastReadMessage?.createdAtMs ?? participant.lastSeenAtMs ?? null,
    };
  }
  return cursors;
}

export function restoredForkSnapshotCloudMessageIds(
  messages: CloudSelfAgentRestoreMessage[],
  forksBySessionId: Record<string, CloudSessionForkSummary>,
) {
  const messagesBySessionId = new Map<string, CloudSelfAgentRestoreMessage[]>();
  for (const message of messages) {
    const bucket = messagesBySessionId.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySessionId.set(message.sessionId, bucket);
  }
  const snapshotIds = new Set<string>();
  for (const fork of Object.values(forksBySessionId)) {
    const forkMessages = messagesBySessionId.get(clean(fork.forkSessionId)) ?? [];
    const parentMessages = messagesBySessionId.get(clean(fork.parentSessionId)) ?? [];
    for (let index = 0; index < forkMessages.length && index < parentMessages.length; index += 1) {
      const forkMessage = forkMessages[index];
      const parentMessage = parentMessages[index];
      if (forkMessage.role !== parentMessage.role || forkMessage.text !== parentMessage.text) break;
      snapshotIds.add(forkMessage.message.messageId);
    }
  }
  return snapshotIds;
}
