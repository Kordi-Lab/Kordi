import { normalizedMessageMentions } from '@/features/chat/messageMentions';
import type { MessageActionMetadata } from '@/kordi-app/types/message';
import { integerMilliseconds } from './cloudGroupDecoding';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function cloudMessageActionFromRecord(value: unknown): MessageActionMetadata | null {
  const record = recordValue(value);
  if (record.schemaVersion !== 1 || !['quote', 'forward', 'thread'].includes(String(record.kind))) return null;
  const source = recordValue(record.source);
  const sourceSessionId = cleanText(source.sourceSessionId);
  const sourceMessageId = cleanText(source.sourceMessageId);
  const senderLabel = cleanText(source.senderLabel);
  if (!sourceSessionId || !sourceMessageId || !senderLabel) return null;
  const attachmentCount = typeof source.attachmentCount === 'number' && Number.isFinite(source.attachmentCount)
    ? Math.max(0, Math.floor(source.attachmentCount))
    : 0;
  const mentions = normalizedMessageMentions(source.mentions);
  return {
    schemaVersion: 1,
    kind: record.kind as MessageActionMetadata['kind'],
    source: {
      sourceSessionId,
      sourceMessageId,
      sourceMessageKind: typeof source.sourceMessageKind === 'string' ? source.sourceMessageKind : null,
      senderLabel,
      textPreview: cleanText(source.textPreview),
      attachmentCount,
      createdAtMs: integerMilliseconds(source.createdAtMs),
      timeLabel: cleanText(source.timeLabel) || null,
      ...(mentions ? { mentions } : {}),
    },
  };
}
