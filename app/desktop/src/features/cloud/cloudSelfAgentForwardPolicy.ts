import type { CloudSelfAgentSyncOperation } from './cloudSelfAgentForwardSync';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

export function localSelfAgentRequestCanPublishExecution(message: CanonicalSessionMessage) {
  const content = message.content && typeof message.content === 'object'
    ? message.content as Record<string, unknown> : {};
  const queueState = typeof content.queueState === 'string' ? content.queueState : message.status;
  return message.senderRole === 'user'
    && !message.sourceTransport?.startsWith('cloud-')
    && !['queued', 'cancelled'].includes(queueState);
}

export function cloudSelfAgentForwardMessageKind(
  operation: Pick<CloudSelfAgentSyncOperation, 'role' | 'sessionId'>,
  historySessionIds: ReadonlySet<string>,
) {
  if (!historySessionIds.has(operation.sessionId)) return null;
  return operation.role === 'user'
    ? 'canonical-history-user'
    : 'canonical-history-agent';
}

export function cloudSelfAgentShouldPublishProgress(
  sessionId: string,
  historySessionIds: ReadonlySet<string>,
  hasActiveLocalTurn = false,
) {
  return hasActiveLocalTurn || !historySessionIds.has(sessionId);
}

export function cloudSelfAgentProgressPolicy(
  historySessionIds: ReadonlySet<string>,
  activeSessionKey: string,
) {
  const activeSessionIds = new Set(activeSessionKey ? activeSessionKey.split('\u0000') : []);
  return (sessionId: string) => cloudSelfAgentShouldPublishProgress(
    sessionId,
    historySessionIds,
    activeSessionIds.has(sessionId),
  );
}
