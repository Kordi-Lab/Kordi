import type { Message, MessageActionMetadata } from '@/kordi-app/types';
import { canonicalMentions } from './mentionMapping';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function canonicalMessageAction(value: unknown): MessageActionMetadata | null {
  const record = recordValue(value);
  if (record.schemaVersion !== 1 || (record.kind !== 'quote' && record.kind !== 'forward')) return null;
  const source = recordValue(record.source);
  const sourceSessionId = stringValue(source.sourceSessionId)?.trim();
  const sourceMessageId = stringValue(source.sourceMessageId)?.trim();
  const senderLabel = stringValue(source.senderLabel)?.trim();
  if (!sourceSessionId || !sourceMessageId || !senderLabel) return null;
  const mentions = canonicalMentions(source.mentions);
  return {
    schemaVersion: 1,
    kind: record.kind,
    source: {
      sourceSessionId,
      sourceMessageId,
      sourceMessageKind: stringValue(source.sourceMessageKind) ?? null,
      senderLabel,
      textPreview: stringValue(source.textPreview)?.trim() ?? '',
      ...(mentions ? { mentions } : {}),
      attachmentCount: Math.max(0, Math.floor(numberValue(source.attachmentCount) ?? 0)),
      createdAtMs: numberValue(source.createdAtMs) ?? null,
      timeLabel: stringValue(source.timeLabel) ?? null,
    },
  };
}

export function canonicalMessageActionSourceReference(
  action: MessageActionMetadata | null,
): Message['sourceMessage'] {
  if (!action || action.kind !== 'quote') return null;
  return {
    messageId: action.source.sourceMessageId,
    senderLabel: action.source.senderLabel,
    text: action.source.textPreview,
    mentions: action.source.mentions,
    attachmentCount: action.source.attachmentCount,
    time: action.source.timeLabel ?? null,
  };
}
