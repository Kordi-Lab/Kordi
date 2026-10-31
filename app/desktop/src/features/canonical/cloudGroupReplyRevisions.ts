import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { canApplyCloudAgentTurnTransition, isTerminalCloudAgentTurn } from './cloudAgentTurnLifecycle';

/** Older clients persisted waiting and completed revisions under different local IDs. */
export function currentCloudGroupReplyRevisions(
  messages: CanonicalSessionMessage[],
): CanonicalSessionMessage[] {
  const latest = new Map<string, { index: number; message: CanonicalSessionMessage; version: number }>();
  const superseded = new Set<number>();
  messages.forEach((message, index) => {
    if (message.sourceTransport !== 'cloud-group-agent') return;
    const content = message.content as Record<string, unknown> | null;
    const cloudId = content?.cloudGroupMessageId;
    if (typeof cloudId !== 'string' || !cloudId) return;
    const key = `${message.sessionId}\u0000${message.senderIdentityId}\u0000${cloudId}`;
    const version = typeof content?.cloudMessageVersion === 'number' ? content.cloudMessageVersion : 0;
    const previous = latest.get(key);
    const replace = !previous || (canApplyCloudAgentTurnTransition(previous.message, message)
      && (version > previous.version || (version === previous.version && (
        isTerminalCloudAgentTurn(message) && !isTerminalCloudAgentTurn(previous.message)
        || message.updatedAtMs >= previous.message.updatedAtMs
      ))));
    if (previous) superseded.add(replace ? previous.index : index);
    if (replace) latest.set(key, { index, message, version });
  });
  return superseded.size ? messages.filter((_, index) => !superseded.has(index)) : messages;
}
