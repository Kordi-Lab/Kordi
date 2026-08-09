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

export function cloudSelfAgentStableResponseId(
  requestCloudMessageId: string,
): string {
  return `msg:cloud:self:response:${requestCloudMessageId}`;
}

export function existingCanonicalMessageMatchesCloudSelfAgent(
  existing: CanonicalSessionMessage,
  input: {
    sessionId: string;
    role: 'user' | 'agent';
    text: string;
    createdAtMs: number;
    cloudMessageId: string;
    canonicalMessageId: string;
  },
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
