import { messageActionPreviewText } from './messageActionMetadata';
import {
  compactTranscriptNavigationIds,
  transcriptMessageNavigationIds,
  transcriptMessageVisibleId,
} from './transcriptMessageIdentity';
import type { Message, MessageSourceReference } from '@/kordi-app/types';

function clean(value?: string | null) {
  return value?.trim() ?? '';
}

function comparableText(value?: string | null) {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

function messageSenderMatchesSource(message: Message, source: MessageSourceReference) {
  const sourceSender = comparableText(source.senderLabel);
  if (!sourceSender) return true;
  if (
    (sourceSender === 'me' || sourceSender === 'you')
    && (message.isOwnMessage ?? message.role === 'user')
  ) {
    return true;
  }
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

export type ResolvedTranscriptNavigationIds = {
  id: string;
  lookupIds: string[];
};

export function resolveTranscriptNavigationIdsForSource(
  source: MessageSourceReference,
  visibleMessages: readonly Message[],
): ResolvedTranscriptNavigationIds {
  const requestedId = clean(source.messageId);
  if (!requestedId) return { id: requestedId, lookupIds: [] };

  const exactMatch = visibleMessages.find((message) => (
    transcriptMessageNavigationIds(message).includes(requestedId)
  ));
  if (exactMatch) {
    return {
      id: transcriptMessageVisibleId(exactMatch) || requestedId,
      lookupIds: compactTranscriptNavigationIds([requestedId, ...transcriptMessageNavigationIds(exactMatch)]),
    };
  }

  const sourceTextMatches = visibleMessages.filter((message) => (
    messageSenderMatchesSource(message, source)
    && messageTextMatchesSource(message, source)
    && (source.attachmentCount ?? 0) === (message.attachments?.length ?? 0)
  ));
  const sourceTime = clean(source.time);
  const sourceTimeMatches = sourceTime
    ? sourceTextMatches.filter((message) => clean(message.time) === sourceTime)
    : [];
  const sourceTextMatch = sourceTextMatches.length === 1
    ? sourceTextMatches[0]
    : sourceTimeMatches.length === 1
      ? sourceTimeMatches[0]
      : null;

  if (!sourceTextMatch) return { id: requestedId, lookupIds: [requestedId] };
  return {
    id: transcriptMessageVisibleId(sourceTextMatch) || requestedId,
    lookupIds: compactTranscriptNavigationIds([requestedId, ...transcriptMessageNavigationIds(sourceTextMatch)]),
  };
}

export function resolveTranscriptMessageIdForSource(
  source: MessageSourceReference,
  visibleMessages: readonly Message[],
) {
  return resolveTranscriptNavigationIdsForSource(source, visibleMessages).id;
}
