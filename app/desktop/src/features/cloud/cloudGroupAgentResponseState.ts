import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { cloudAgentMessageOwnedBy } from './cloudAgentIdentity';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type CloudGroupAgentMentionResponseState = 'processing' | 'terminal';

export function cloudGroupAgentMentionResponseState(input: {
  requestMessageId: string;
  targetAccountId: string;
  messages: CanonicalSessionMessage[];
}): CloudGroupAgentMentionResponseState | null {
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  if (!requestMessageId || !targetAccountId) return null;
  let sawProcessing = false;
  for (const message of input.messages) {
    if (message.sourceTransport !== 'cloud-group-agent') continue;
    const content = objectRecord(message.content);
    if (!cloudAgentMessageOwnedBy(message, targetAccountId)) continue;
    const linkedRequestId = cleanText(message.parentMessageId)
      || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
      || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
    if (linkedRequestId !== requestMessageId) continue;
    const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
    if (message.status === 'processing' || deliveryState === 'processing') {
      sawProcessing = true;
      continue;
    }
    return 'terminal';
  }
  return sawProcessing ? 'processing' : null;
}

export function cloudGroupAgentMentionHasResponse(input: {
  requestMessageId: string;
  targetAccountId: string;
  messages: CanonicalSessionMessage[];
}): boolean {
  return cloudGroupAgentMentionResponseState(input) !== null;
}

export function cloudGroupAgentMentionResponseStateFromRows(input: {
  requestMessageId: string;
  targetAccountId: string;
  rows: readonly IndexedCloudGroupRow[];
}): CloudGroupAgentMentionResponseState | null {
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  if (!requestMessageId || !targetAccountId) return null;
  let sawProcessing = false;
  for (const { envelope } of input.rows) {
    const message = envelope.kind === 'group-message'
      ? envelope.message
      : null;
    if (
      !message
      || message.senderKind !== 'agent'
      || message.senderAccountId !== targetAccountId
    ) continue;
    const linkedRequestId = cleanText(message.requestId)
      || cleanText(message.replyToMessageId);
    if (linkedRequestId !== requestMessageId) continue;
    if (message.deliveryState === 'processing') {
      sawProcessing = true;
      continue;
    }
    return 'terminal';
  }
  return sawProcessing ? 'processing' : null;
}

export function cloudGroupAgentMentionResponseStateFromSources(input: {
  requestMessageId: string;
  targetAccountId: string;
  messages: CanonicalSessionMessage[];
  rows: readonly IndexedCloudGroupRow[];
}) {
  const canonical = cloudGroupAgentMentionResponseState(input);
  const cloud = cloudGroupAgentMentionResponseStateFromRows(input);
  return canonical === 'terminal' || cloud === 'terminal'
    ? 'terminal' as const
    : canonical ?? cloud;
}
