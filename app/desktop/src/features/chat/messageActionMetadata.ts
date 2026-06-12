import type { Message } from '../../kordi-app/types/message';

export type MessageActionKind = 'quote' | 'forward';

export type MessageActionSource = {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceMessageKind?: string | null;
  senderLabel: string;
  textPreview: string;
  attachmentCount: number;
  createdAtMs?: number | null;
  timeLabel?: string | null;
};

export type MessageActionMetadata = {
  schemaVersion: 1;
  kind: MessageActionKind;
  source: MessageActionSource;
};

function clean(value?: string | null): string {
  return value?.trim() ?? '';
}

export function messageActionPreviewText(
  message: Pick<Message, 'text' | 'turn' | 'detail' | 'attachments'>,
  maxChars = 220,
): string {
  const raw = clean(message.turn?.assistantText) || clean(message.text) || clean(message.detail);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const fallback = !normalized && (message.attachments?.length ?? 0) > 0
    ? `${message.attachments!.length} attachment${message.attachments!.length === 1 ? '' : 's'}`
    : normalized;
  if (fallback.length <= maxChars) {
    return fallback;
  }
  return `${fallback.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function messageActionSourceFromMessage(
  message: Message,
  sourceSessionId: string,
): MessageActionSource | null {
  const sourceMessageId = clean(message.id) || clean(message.entryId);
  const sessionId = clean(sourceSessionId);
  if (!sourceMessageId || !sessionId) {
    return null;
  }
  const senderLabel = clean(message.sourceSenderLabel) || clean(message.sender)
    || (message.isOwnMessage ? 'You' : message.role === 'owned-agent' ? 'My Kordi' : message.role);
  return {
    sourceSessionId: sessionId,
    sourceMessageId,
    sourceMessageKind: message.turn ? 'agent-turn' : 'text',
    senderLabel,
    textPreview: messageActionPreviewText(message),
    attachmentCount: message.attachments?.length ?? 0,
    timeLabel: clean(message.time) || null,
    createdAtMs: null,
  };
}

export function quoteMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'quote', source };
}

export function forwardMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'forward', source };
}

export function isMessageActionMetadata(value: unknown): value is MessageActionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  return record.schemaVersion === 1
    && (record.kind === 'quote' || record.kind === 'forward')
    && Boolean(source)
    && typeof source?.sourceSessionId === 'string'
    && typeof source.sourceMessageId === 'string'
    && typeof source.senderLabel === 'string';
}
