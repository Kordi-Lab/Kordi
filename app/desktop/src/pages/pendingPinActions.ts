import type { CloudPinHistoryEvent } from '@/features/cloud/cloudPinHistory';

export type PendingPinAction = { event: CloudPinHistoryEvent; knownIds: string[]; resolvedId?: string };

export function resolvePendingPinActions(actions: readonly PendingPinAction[], history: readonly CloudPinHistoryEvent[]): PendingPinAction[] {
  const claimed = new Set(actions.flatMap(action => action.resolvedId ? [action.resolvedId] : []));
  return actions.map(action => {
    if (action.resolvedId) return action;
    const { event, knownIds } = action;
    const canonical = history.find(candidate => !knownIds.includes(candidate.id) && !claimed.has(candidate.id)
      && candidate.kind === event.kind && candidate.scope === event.scope && candidate.messageId === event.messageId
      && candidate.updatedByAccountId === event.updatedByAccountId);
    if (!canonical) return action;
    claimed.add(canonical.id);
    return { ...action, resolvedId: canonical.id };
  });
}

export function remainingPendingPinActions(actions: readonly PendingPinAction[], history: readonly CloudPinHistoryEvent[]): PendingPinAction[] {
  return resolvePendingPinActions(actions, history).filter(action => !action.resolvedId);
}
