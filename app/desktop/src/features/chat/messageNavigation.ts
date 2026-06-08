import { messageActionPreviewText } from './messageActionMetadata';
import type { Message, MessageSourceReference } from '@/kordi-app/types';

function clean(value?: string | null) {
  return value?.trim() ?? '';
}

function comparableText(value?: string | null) {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

function messageVisibleId(message: Message) {
  return clean(message.id) || clean(message.entryId) || clean(message.turn?.id);
}

function messageIdCandidates(message: Message) {
  return [message.id, message.entryId, message.turn?.id]
    .map(clean)
    .filter(Boolean);
}

function messageSenderMatchesSource(message: Message, source: MessageSourceReference) {
  const sourceSender = comparableText(source.senderLabel);
  if (!sourceSender) return true;
  const candidateSenders = [message.sender, message.sourceSenderLabel, message.messageAction?.source.senderLabel]
    .map(comparableText)
    .filter(Boolean);
  return candidateSenders.includes(sourceSender);
}

function messageTextMatchesSource(message: Message, source: MessageSourceReference) {
  const sourceText = comparableText(source.text);
  if (!sourceText) return false;
  const candidateText = comparableText(messageActionPreviewText(message, Math.max(220, source.text.length + 8)));
  if (!candidateText) return false;
  return candidateText === sourceText || candidateText.startsWith(sourceText) || sourceText.startsWith(candidateText);
}

export function resolveTranscriptMessageIdForSource(
  source: MessageSourceReference,
  visibleMessages: readonly Message[],
) {
  const requestedId = clean(source.messageId);
  if (!requestedId) return requestedId;

  const exactMatch = visibleMessages.find((message) => messageIdCandidates(message).includes(requestedId));
  if (exactMatch) return messageVisibleId(exactMatch) || requestedId;

  const sourceTextMatch = visibleMessages.find((message) => (
    messageSenderMatchesSource(message, source)
    && messageTextMatchesSource(message, source)
    && (source.attachmentCount ?? 0) === (message.attachments?.length ?? 0)
  ));

  return sourceTextMatch ? messageVisibleId(sourceTextMatch) || requestedId : requestedId;
}
