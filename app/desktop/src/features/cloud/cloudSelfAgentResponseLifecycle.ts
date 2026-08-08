import type {
  CanonicalSessionMessage,
} from '@/kordi-app/types';

export type CloudSelfAgentResponseDeliveryState =
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

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
  for (const response of responses) {
    const legacy = canonicalMessages.find((candidate) => (
      candidate.sessionId === response.sessionId
      && candidate.sourceTransport === 'cloud-self-agent'
      && candidate.sourceEventId === response.responseCloudMessageId
      && (
        candidate.senderRole.includes('agent')
        || candidate.messageKind === 'agent-turn'
      )
    ));
    if (legacy) {
      legacyByStableId.set(
        cloudSelfAgentStableResponseId(response.requestCloudMessageId),
        legacy.id,
      );
    }
  }
  return legacyByStableId;
}

export function processingWouldDowngradeTerminal(
  existingStatus: string | null | undefined,
  nextDeliveryState: CloudSelfAgentResponseDeliveryState | null,
): boolean {
  return nextDeliveryState === 'processing'
    && cleanText(existingStatus).toLowerCase() !== 'processing';
}
