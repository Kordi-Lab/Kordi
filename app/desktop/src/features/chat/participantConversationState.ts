import type { Conversation } from '@/kordi-app/types';

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

export function latestParticipantSpaceMessageText(conversation: Conversation) {
  const latest = conversation.messages[conversation.messages.length - 1];
  return safePreviewText(latest?.text)
    || safePreviewText(latest?.turn?.assistantText)
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
  return conversation.messages.some((message) => message.role !== 'system' && message.text.trim().length > 0);
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
