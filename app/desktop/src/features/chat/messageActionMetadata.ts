import { messageMentionsForText } from './messageMentions';
import type { Message, MessageAttachment, MessageMention, MessageVoice } from '../../kordi-app/types/message';

export type MessageActionKind = 'quote' | 'forward';

export type MessageActionSource = {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceMessageKind?: string | null;
  senderLabel: string;
  textPreview: string;
  mentions?: MessageMention[];
  attachmentCount: number;
  createdAtMs?: number | null;
  timeLabel?: string | null;
};

/**
 * Transient source data used only while the forward dialog is open.
 * Attachments must never be persisted inside message-action metadata because
 * they can contain device-local paths.
 */
export type ForwardMessageSource = MessageActionSource & {
  attachments: MessageAttachment[];
  voiceMessage?: MessageVoice | null;
  attachmentOnly: boolean;
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
    || (message.isOwnMessage ? 'You' : message.role === 'owned-agent' ? 'Kordi' : message.role);
  const textPreview = messageActionPreviewText(message);
  const mentions = messageMentionsForText(textPreview, message.mentions);
  return {
    sourceSessionId: sessionId,
    sourceMessageId,
    sourceMessageKind: message.turn ? 'agent-turn' : 'text',
    senderLabel,
    textPreview,
    ...(mentions ? { mentions } : {}),
    attachmentCount: message.attachments?.length ?? 0,
    timeLabel: clean(message.time) || null,
    createdAtMs: null,
  };
}

export function forwardMessageSourceFromMessage(
  message: Message,
  sourceSessionId: string,
): ForwardMessageSource | null {
  const source = messageActionSourceFromMessage(message, sourceSessionId);
  if (!source) return null;
  const attachments = (message.attachments ?? []).map((attachment) => ({ ...attachment }));
  const messageText = clean(message.turn?.assistantText) || clean(message.text) || clean(message.detail);
  return {
    ...source,
    attachments,
    voiceMessage: message.voiceMessage ?? null,
    attachmentOnly: attachments.length > 0 && !messageText,
  };
}

export function persistedMessageActionSource(source: MessageActionSource): MessageActionSource {
  const mentions = messageMentionsForText(source.textPreview, source.mentions);
  return {
    sourceSessionId: source.sourceSessionId,
    sourceMessageId: source.sourceMessageId,
    sourceMessageKind: source.sourceMessageKind,
    senderLabel: source.senderLabel,
    textPreview: source.textPreview,
    ...(mentions ? { mentions } : {}),
    attachmentCount: source.attachmentCount,
    createdAtMs: source.createdAtMs,
    timeLabel: source.timeLabel,
  };
}

export function quoteMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'quote', source: persistedMessageActionSource(source) };
}

export function forwardMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'forward', source: persistedMessageActionSource(source) };
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
