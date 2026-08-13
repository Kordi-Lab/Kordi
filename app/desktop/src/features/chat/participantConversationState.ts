import type { Conversation, Message } from '@/kordi-app/types';

function cleanText(value?: string | null) {
  return value?.trim() ?? '';
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function safePreviewText(value: string | undefined | null) {
  const text = value?.trim() ?? '';
  const rawId = text.startsWith('session:')
    || text.startsWith('bridge:')
    || text.startsWith('canonical:')
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  return text && !rawId ? text : '';
}

export type AttachmentOnlyMessagePreview = {
  kind: 'image' | 'file';
  label: string;
};

export function attachmentOnlyMessagePreview(
  message: Pick<Message, 'text' | 'turn' | 'attachments'> | undefined,
): AttachmentOnlyMessagePreview | null {
  if (!message) return null;
  if (safePreviewText(message.text) || safePreviewText(message.turn?.assistantText)) {
    return null;
  }

  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return null;

  const imageCount = attachments.filter(
    (attachment) =>
      attachment.kind === 'image'
      || attachment.mimeType?.toLowerCase().startsWith('image/'),
  ).length;
  if (imageCount === attachments.length) {
    return {
      kind: 'image',
      label: attachments.length === 1 ? 'Photo' : `${attachments.length} photos`,
    };
  }
  if (attachments.length === 1) {
    return {
      kind: 'file',
      label: safePreviewText(attachments[0]?.name) || 'File',
    };
  }
  return { kind: 'file', label: `${attachments.length} attachments` };
}

export function latestParticipantSpaceMessageText(conversation: Conversation) {
  const latest = conversation.messages[conversation.messages.length - 1];
  return safePreviewText(latest?.text)
    || safePreviewText(latest?.turn?.assistantText)
    || attachmentOnlyMessagePreview(latest)?.label
    || safePreviewText(conversation.subtitle)
    || safePreviewText(conversation.name);
}

export function isBlankSessionLabel(value: string | undefined | null) {
  const text = value?.trim() ?? '';
  return !text || /^(#\s*)?(new chat|new session|untitled session)$/i.test(text);
}

export function conversationHasUserContent(conversation: Conversation) {
  if (typeof conversation.canonicalMessageCount === 'number' && conversation.canonicalMessageCount > 0) return true;
  if (conversation.previewLiveTurn || conversation.queuedMessages?.length) return true;
  return conversation.messages.some((message) => (
    message.role !== 'system'
    && (
      message.text.trim().length > 0
      || (message.attachments?.length ?? 0) > 0
      || Boolean(message.turn?.assistantText.trim())
    )
  ));
}

export function isBlankConversation(conversation: Conversation) {
  return !conversationHasUserContent(conversation) && isBlankSessionLabel(conversation.name);
}

export function isPersistedBlankGroupContinuationConversation(conversation: Conversation) {
  if (conversation.transientDraft || !isBlankConversation(conversation)) return false;
  const metadata = metadataRecord(conversation.metadata);
  const sessionId = cleanText(conversation.canonicalSessionId) || cleanText(conversation.id);
  const groupSpaceId = (metadataText(metadata, 'groupSpaceId') || metadataText(metadata, 'groupId'))
    .replace(/^group:/, '');
  return Boolean(
    metadataText(metadata, 'continuedFromSessionId')
      || metadataText(metadata, 'continuedFromSpaceId')
      || (groupSpaceId && groupSpaceId !== sessionId),
  );
}
