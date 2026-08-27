import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudSessionForkSummary } from './authClient';
import type { CloudGroupReadCursor } from './cloudGroupMessages';
import type { CloudSelfAgentRestoreMessage } from './cloudSelfAgentRestoreMessage';

const clean = (value?: string | null) => (value ?? '').trim();

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
