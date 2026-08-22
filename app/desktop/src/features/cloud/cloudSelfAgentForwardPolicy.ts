import type { CloudSelfAgentSyncOperation } from './cloudSelfAgentForwardSync';

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
