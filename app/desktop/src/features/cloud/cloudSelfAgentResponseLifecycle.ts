import type {
  CanonicalSessionMessage,
} from '@/kordi-app/types';

export type CloudSelfAgentResponseDeliveryState =
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

const DELIVERY_STATE_PRIORITY: Record<
  CloudSelfAgentResponseDeliveryState,
  number
> = {
  processing: 0,
  failed: 1,
  cancelled: 2,
  complete: 3,
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

type CloudSelfAgentCanonicalMatchInput = {
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  createdAtMs: number;
  cloudMessageId: string;
  canonicalMessageId: string;
};

type IndexedLocalUserMessage = {
  message: CanonicalSessionMessage;
  originalIndex: number;
};

export type CloudSelfAgentCanonicalMessageIndex = {
  byId: Map<string, CanonicalSessionMessage>;
  bySessionAndSourceEvent: Map<string, CanonicalSessionMessage>;
  byExactReplay: Map<string, CanonicalSessionMessage>;
  cloudReplaysBySessionRoleAndText: Map<string, IndexedLocalUserMessage[]>;
  localUsersBySessionAndText: Map<string, IndexedLocalUserMessage[]>;
};

const LEGACY_SELF_REPLAY_WINDOW_MS = 1_000;

function sessionValueKey(sessionId: string, value: string): string {
  return `${sessionId}\u0000${value}`;
}

function exactReplayKey({
  sessionId,
  role,
  text,
  createdAtMs,
}: Pick<
  CloudSelfAgentCanonicalMatchInput,
  'sessionId' | 'role' | 'text' | 'createdAtMs'
>) {
  return [sessionId, role, createdAtMs.toString(), text].join('\u0000');
}

function replayValueKey(sessionId: string, role: 'user' | 'agent', text: string) {
  return [sessionId, role, text].join('\u0000');
}

export function cloudSelfAgentStableResponseId(
  requestCloudMessageId: string,
): string {
  return `msg:cloud:self:response:${requestCloudMessageId}`;
}

export function existingCanonicalMessageMatchesCloudSelfAgent(
  existing: CanonicalSessionMessage,
  input: CloudSelfAgentCanonicalMatchInput,
): boolean {
  if (existing.sessionId !== input.sessionId) return false;
  if (existing.id === input.canonicalMessageId) return true;
  if (
    existing.sourceTransport === 'cloud-self-agent'
    && existing.sourceEventId === input.cloudMessageId
  ) return true;
  if (input.role === 'agent') return false;
  const existingText = cleanText(existing.contentText);
  if (!existingText || existingText !== input.text) return false;
  if (existing.senderRole !== 'user') return false;
  return Math.abs(existing.createdAtMs - input.createdAtMs) <= 5_000;
}

export function createCloudSelfAgentCanonicalMessageIndex(
  messages: readonly CanonicalSessionMessage[],
): CloudSelfAgentCanonicalMessageIndex {
  const byId = new Map<string, CanonicalSessionMessage>();
  const bySessionAndSourceEvent = new Map<string, CanonicalSessionMessage>();
  const byExactReplay = new Map<string, CanonicalSessionMessage>();
  const cloudReplaysBySessionRoleAndText =
    new Map<string, IndexedLocalUserMessage[]>();
  const localUsersBySessionAndText =
    new Map<string, IndexedLocalUserMessage[]>();
  messages.forEach((message, originalIndex) => {
    if (!byId.has(message.id)) byId.set(message.id, message);
    if (
      message.sourceTransport === 'cloud-self-agent'
      && message.sourceEventId
    ) {
      const key = sessionValueKey(message.sessionId, message.sourceEventId);
      if (!bySessionAndSourceEvent.has(key)) {
        bySessionAndSourceEvent.set(key, message);
      }
    }
    const text = cleanText(message.contentText);
    const replayRole = message.senderRole === 'user'
      ? 'user'
      : message.senderRole.includes('agent')
          || message.messageKind === 'agent-turn'
        ? 'agent'
        : null;
    if (
      message.sourceTransport === 'cloud-self-agent'
      && replayRole
      && text
    ) {
      const key = exactReplayKey({
        sessionId: message.sessionId,
        role: replayRole,
        text,
        createdAtMs: message.createdAtMs,
      });
      if (!byExactReplay.has(key)) byExactReplay.set(key, message);
      const replayKey = replayValueKey(message.sessionId, replayRole, text);
      const replayEntries = cloudReplaysBySessionRoleAndText.get(replayKey) ?? [];
      replayEntries.push({ message, originalIndex });
      cloudReplaysBySessionRoleAndText.set(replayKey, replayEntries);
    }
    if (
      message.senderRole !== 'user'
      || !text
      || message.sourceTransport === 'cloud-self-agent'
      || message.id.startsWith('msg:cloud:self:')
    ) return;
    const key = sessionValueKey(message.sessionId, text);
    const entries = localUsersBySessionAndText.get(key) ?? [];
    entries.push({ message, originalIndex });
    localUsersBySessionAndText.set(key, entries);
  });
  for (const entries of [
    ...cloudReplaysBySessionRoleAndText.values(),
    ...localUsersBySessionAndText.values(),
  ]) {
    entries.sort((left, right) => (
      left.message.createdAtMs - right.message.createdAtMs
      || left.originalIndex - right.originalIndex
    ));
  }
  return {
    byId,
    bySessionAndSourceEvent,
    byExactReplay,
    cloudReplaysBySessionRoleAndText,
    localUsersBySessionAndText,
  };
}

function firstMessageAtOrAfter(
  entries: readonly IndexedLocalUserMessage[],
  createdAtMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle].message.createdAtMs < createdAtMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function findExistingCanonicalCloudSelfAgentMessage(
  index: CloudSelfAgentCanonicalMessageIndex,
  input: CloudSelfAgentCanonicalMatchInput,
): CanonicalSessionMessage | null {
  const exact = index.byId.get(input.canonicalMessageId);
  if (exact && existingCanonicalMessageMatchesCloudSelfAgent(exact, input)) {
    return exact;
  }
  const source = index.bySessionAndSourceEvent.get(
    sessionValueKey(input.sessionId, input.cloudMessageId),
  );
  if (source && existingCanonicalMessageMatchesCloudSelfAgent(source, input)) {
    return source;
  }
  const exactReplay = index.byExactReplay.get(exactReplayKey(input));
  if (exactReplay) return exactReplay;
  const cloudReplayEntries = index.cloudReplaysBySessionRoleAndText.get(
    replayValueKey(input.sessionId, input.role, input.text),
  ) ?? [];
  const cloudReplayAfterIndex = firstMessageAtOrAfter(
    cloudReplayEntries,
    input.createdAtMs,
  );
  const cloudReplayCandidates: IndexedLocalUserMessage[] = [];
  if (cloudReplayAfterIndex < cloudReplayEntries.length) {
    cloudReplayCandidates.push(cloudReplayEntries[cloudReplayAfterIndex]);
  }
  if (cloudReplayAfterIndex > 0) {
    cloudReplayCandidates.push(cloudReplayEntries[cloudReplayAfterIndex - 1]);
  }
  cloudReplayCandidates.sort((left, right) => (
    Math.abs(left.message.createdAtMs - input.createdAtMs)
      - Math.abs(right.message.createdAtMs - input.createdAtMs)
    || left.originalIndex - right.originalIndex
  ));
  const closestCloudReplay = cloudReplayCandidates[0]?.message ?? null;
  if (
    closestCloudReplay
    && Math.abs(closestCloudReplay.createdAtMs - input.createdAtMs)
      < LEGACY_SELF_REPLAY_WINDOW_MS
  ) return closestCloudReplay;
  if (input.role === 'agent') return null;
  const entries = index.localUsersBySessionAndText.get(
    sessionValueKey(input.sessionId, input.text),
  ) ?? [];
  const afterIndex = firstMessageAtOrAfter(entries, input.createdAtMs);
  const candidates: IndexedLocalUserMessage[] = [];
  if (afterIndex < entries.length) candidates.push(entries[afterIndex]);
  if (afterIndex > 0) {
    const previousAt = entries[afterIndex - 1].message.createdAtMs;
    candidates.push(entries[firstMessageAtOrAfter(entries, previousAt)]);
  }
  candidates.sort((left, right) => (
    Math.abs(left.message.createdAtMs - input.createdAtMs)
      - Math.abs(right.message.createdAtMs - input.createdAtMs)
    || left.originalIndex - right.originalIndex
  ));
  const closest = candidates[0]?.message ?? null;
  return closest
    && existingCanonicalMessageMatchesCloudSelfAgent(closest, input)
    ? closest
    : null;
}

export function legacyCloudSelfAgentResponseIds({
  canonicalMessages,
  responses,
}: {
  canonicalMessages: readonly CanonicalSessionMessage[];
  responses: readonly {
    sessionId: string;
    requestCloudMessageId: string;
    responseCloudMessageId: string;
  }[];
}): Map<string, string> {
  const legacyByStableId = new Map<string, string>();
  const legacyBySessionAndSourceEvent = new Map<string, string>();
  for (const candidate of canonicalMessages) {
    if (
      candidate.sourceTransport !== 'cloud-self-agent'
      || !candidate.sourceEventId
      || (
        !candidate.senderRole.includes('agent')
        && candidate.messageKind !== 'agent-turn'
      )
    ) continue;
    legacyBySessionAndSourceEvent.set(
      `${candidate.sessionId}\u0000${candidate.sourceEventId}`,
      candidate.id,
    );
  }
  for (const response of responses) {
    const legacyId = legacyBySessionAndSourceEvent.get(
      `${response.sessionId}\u0000${response.responseCloudMessageId}`,
    );
    if (legacyId) {
      legacyByStableId.set(
        cloudSelfAgentStableResponseId(response.requestCloudMessageId),
        legacyId,
      );
    }
  }
  return legacyByStableId;
}

function normalizedDeliveryState(
  value: string | null | undefined,
): CloudSelfAgentResponseDeliveryState | null {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'completed' || normalized === 'succeeded') {
    return 'complete';
  }
  if (normalized === 'canceled') return 'cancelled';
  return normalized in DELIVERY_STATE_PRIORITY
    ? normalized as CloudSelfAgentResponseDeliveryState
    : null;
}

export function cloudSelfAgentResponseWouldDowngrade(
  existingStatus: string | null | undefined,
  nextDeliveryState: CloudSelfAgentResponseDeliveryState | null,
): boolean {
  const existingDeliveryState = normalizedDeliveryState(existingStatus);
  if (!existingDeliveryState || !nextDeliveryState) return false;
  return DELIVERY_STATE_PRIORITY[nextDeliveryState]
    < DELIVERY_STATE_PRIORITY[existingDeliveryState];
}

export function shouldReplacePlannedCloudSelfAgentResponse(
  currentStatus: string | null | undefined,
  nextDeliveryState: CloudSelfAgentResponseDeliveryState,
): boolean {
  const currentDeliveryState = normalizedDeliveryState(currentStatus);
  if (!currentDeliveryState) return true;
  const currentPriority = DELIVERY_STATE_PRIORITY[currentDeliveryState];
  const nextPriority = DELIVERY_STATE_PRIORITY[nextDeliveryState];
  return nextPriority > currentPriority
    || (
      nextPriority === currentPriority
      && nextDeliveryState !== 'processing'
    );
}
