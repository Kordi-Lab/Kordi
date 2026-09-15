import type { CloudSessionPin } from './cloudSessionPinTypes';
export type CloudPinHistoryEvent = {
  id: string;
  sequence?: number;
  sessionId: string;
  kind: 'pinned' | 'unpinned';
  scope: 'private' | 'shared';
  messageId: string | null;
  updatedByAccountId: string;
  updatedAt: string;
};

export function mergePinHistory(...groups: readonly (readonly CloudPinHistoryEvent[] | undefined)[]): CloudPinHistoryEvent[] {
  const byId = new Map<string, CloudPinHistoryEvent>();
  for (const group of groups) for (const event of group ?? []) {
    if (event.id && ['pinned', 'unpinned'].includes(event.kind) && ['private', 'shared'].includes(event.scope) && Number.isFinite(Date.parse(event.updatedAt))) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
}

export function mergePinSnapshot(current: CloudSessionPin | undefined, incoming: CloudSessionPin): CloudSessionPin {
  const oldTime = Date.parse(current?.updatedAt ?? '');
  const newTime = Date.parse(incoming.updatedAt ?? '');
  const state = current && Number.isFinite(oldTime) && (!Number.isFinite(newTime) || newTime < oldTime) ? current : incoming;
  return { ...state, history: mergePinHistory(current?.history, incoming.history) };
}
