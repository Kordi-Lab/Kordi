import type { CloudPinHistoryEvent } from '@/features/cloud/cloudPinHistory';

export type PendingPinAction = { event: CloudPinHistoryEvent; knownIds: string[] };

export function remainingPendingPinActions(actions: readonly PendingPinAction[], history: readonly CloudPinHistoryEvent[]): PendingPinAction[] {
  const claimed = new Set<string>();
  return actions.filter(({ event, knownIds }) => {
    const canonical = history.find(candidate => !knownIds.includes(candidate.id) && !claimed.has(candidate.id)
      && candidate.kind === event.kind && candidate.scope === event.scope && candidate.messageId === event.messageId
      && candidate.updatedByAccountId === event.updatedByAccountId);
    if (canonical) claimed.add(canonical.id);
    return !canonical;
  });
}
