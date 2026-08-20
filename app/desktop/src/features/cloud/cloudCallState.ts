import type { ActiveCloudCall, CloudCall, CloudCallKind } from './cloudCalls';
import type { CurrentCallState, PresentedCloudCall } from './cloudCallController';
import type { Conversation } from '@/kordi-app/types';

export function mediaDeviceFallbackLabel(kind: MediaDeviceKind, position: number): string {
  if (kind === 'audioinput') return `Microphone ${position}`;
  if (kind === 'audiooutput') return `Speaker ${position}`;
  return `Camera ${position}`;
}

export function canSwitchAudioOutput(): boolean {
  return typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype;
}

export function conversationSessionId(conversation: Conversation): string {
  return (conversation.canonicalSessionId || conversation.id).trim();
}

export function callParticipant(call: CloudCall, accountId: string | undefined) {
  return accountId
    ? call.participants.find((participant) => participant.accountId === accountId) ?? null
    : null;
}

export function callStartedOnAnotherDevice(call: CloudCall, accountId: string): boolean {
  const participant = callParticipant(call, accountId);
  return call.createdByAccountId === accountId || participant?.state === 'joined';
}

export function preferredCallEntry(
  entries: Array<[string, CloudCall]>,
  predicate: (call: CloudCall) => boolean,
): PresentedCloudCall | null {
  const entry = entries.find(([, call]) => (
    call.state !== 'ended' && !call.endedAt && predicate(call)
  ));
  return entry ? { sessionId: entry[0], call: entry[1] } : null;
}

export function newestCloudCallSnapshot(current: CloudCall, incoming: CloudCall): CloudCall {
  if (current.id !== incoming.id) return incoming;
  if (current.state === 'ended' || current.endedAt) return current;
  if (incoming.state === 'ended' || incoming.endedAt) return incoming;
  return incoming.revision >= current.revision ? incoming : current;
}

export function reconcileCloudCallSnapshot(
  existing: Readonly<Record<string, CloudCall>>,
  call: CloudCall,
  sessionId?: string | null,
): Record<string, CloudCall> {
  const resolvedSessionId = sessionId?.trim() || null;
  if (call.state === 'ended' || call.endedAt) {
    const matchingEntries = Object.entries(existing).filter(([, value]) => value.id === call.id);
    if (matchingEntries.length === 0) return existing;
    const next = { ...existing };
    for (const [key] of matchingEntries) delete next[key];
    return next;
  }
  if (!resolvedSessionId || existing[resolvedSessionId] === call) return existing;
  const current = existing[resolvedSessionId];
  const next = current ? newestCloudCallSnapshot(current, call) : call;
  return next === current ? existing : { ...existing, [resolvedSessionId]: next };
}

export function activeCallsBySessionId(
  calls: readonly ActiveCloudCall[],
  knownSessionIds: ReadonlySet<string>,
  locallyEndedCallIds: ReadonlySet<string>,
): Record<string, CloudCall> {
  const next: Record<string, CloudCall> = {};
  for (const entry of calls) {
    if (!entry.sessionId
      || !knownSessionIds.has(entry.sessionId)
      || locallyEndedCallIds.has(entry.call.id)
      || entry.call.state === 'ended'
      || entry.call.endedAt) continue;
    next[entry.sessionId] = entry.call;
  }
  return next;
}

export function callMutationCompleted(
  action: 'leave' | 'end',
  callKind: CloudCallKind,
  updated: CloudCall | null,
): updated is CloudCall {
  return Boolean(updated && (
    (action === 'leave' && callKind === 'meeting')
    || updated.state === 'ended'
    || updated.endedAt
  ));
}

export function shouldApplyActiveCallSnapshot(
  request: number,
  latestRequest: number,
  snapshotGeneration: number,
  latestSnapshotGeneration: number,
): boolean {
  return request === latestRequest && snapshotGeneration === latestSnapshotGeneration;
}

export type { CurrentCallState };
