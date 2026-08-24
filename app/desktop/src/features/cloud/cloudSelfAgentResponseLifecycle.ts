import type {
  CanonicalSessionMessage,
} from '@/kordi-app/types';
import { isProcessingPlaceholderText } from '@/features/collaboration/agentPlaceholderText';

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

export function cloudSelfAgentProcessingTextWouldRegress(
  existingText: string,
  nextText: string,
): boolean {
  const visibleLength = (text: string) => {
    const trimmed = text.trim();
    return isProcessingPlaceholderText(trimmed) ? 0 : trimmed.length;
  };
  return visibleLength(nextText) < visibleLength(existingText);
}

type CloudSelfAgentCanonicalMatchInput = {
  sessionId: string;
  role: 'user' | 'agent' | 'system';
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
  localUsersBySessionAndText: Map<string, IndexedLocalUserMessage[]>;
};

function sessionValueKey(sessionId: string, value: string): string {
  return `${sessionId}\u0000${value}`;
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
  if (input.role !== 'user') return false;
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
  for (const entries of localUsersBySessionAndText.values()) {
    entries.sort((left, right) => (
      left.message.createdAtMs - right.message.createdAtMs
      || left.originalIndex - right.originalIndex
    ));
  }
  return { byId, bySessionAndSourceEvent, localUsersBySessionAndText };
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
  if (input.role !== 'user') return null;
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
    const stableId = cloudSelfAgentStableResponseId(
      response.requestCloudMessageId,
    );
    if (legacyId && !legacyByStableId.has(stableId)) {
      // Keep the earliest persisted lifecycle row. A later terminal Cloud
      // message must update the processing row instead of creating a second
      // completed response below it.
      legacyByStableId.set(stableId, legacyId);
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
  existingText = '',
  nextText = '',
): boolean {
  const existingDeliveryState = normalizedDeliveryState(existingStatus);
  if (!existingDeliveryState || !nextDeliveryState) return false;
  const existingPriority = DELIVERY_STATE_PRIORITY[existingDeliveryState];
  const nextPriority = DELIVERY_STATE_PRIORITY[nextDeliveryState];
  return nextPriority < existingPriority || (
    nextPriority === existingPriority
    && nextDeliveryState === 'processing'
    && cloudSelfAgentProcessingTextWouldRegress(existingText, nextText)
  );
}

export function shouldReplacePlannedCloudSelfAgentResponse(
  currentStatus: string | null | undefined,
  nextDeliveryState: CloudSelfAgentResponseDeliveryState,
  currentText = '',
  nextText = '',
): boolean {
  const currentDeliveryState = normalizedDeliveryState(currentStatus);
  if (!currentDeliveryState) return true;
  const currentPriority = DELIVERY_STATE_PRIORITY[currentDeliveryState];
  const nextPriority = DELIVERY_STATE_PRIORITY[nextDeliveryState];
  // Cloud lifecycle rows are append-only. Equal-priority rows replace older
  // snapshots so owner-visible execution progress updates in place; terminal
  // rows remain protected from processing rows by their higher priority.
  return nextPriority > currentPriority || (
    nextPriority === currentPriority
    && (
      nextDeliveryState !== 'processing'
      || !cloudSelfAgentProcessingTextWouldRegress(currentText, nextText)
    )
  );
}
