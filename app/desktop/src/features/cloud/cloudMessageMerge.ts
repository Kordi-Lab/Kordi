import type { CloudMessage } from './authClient';

export function latestCloudReceiptAt(
  current: string | null,
  incoming: string | null,
): string | null {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentMs = Date.parse(current);
  const incomingMs = Date.parse(incoming);
  if (Number.isFinite(currentMs) && Number.isFinite(incomingMs)) {
    return incomingMs >= currentMs ? incoming : current;
  }
  return incoming.localeCompare(current) >= 0 ? incoming : current;
}

export function cloudMessageAttachmentsEqual(
  left: CloudMessage['attachments'] = [],
  right: CloudMessage['attachments'] = [],
): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((attachment, index) => {
    const other = (right ?? [])[index];
    return Boolean(other)
      && attachment.attachmentId === other.attachmentId
      && (attachment.previewAttachmentId ?? null) === (other.previewAttachmentId ?? null)
      && attachment.name === other.name
      && attachment.kind === other.kind
      && (attachment.mimeType ?? null) === (other.mimeType ?? null)
      && (attachment.sizeBytes ?? null) === (other.sizeBytes ?? null)
      && (attachment.widthPixels ?? null) === (other.widthPixels ?? null)
      && (attachment.heightPixels ?? null) === (other.heightPixels ?? null)
      && (attachment.downloadUrl ?? null) === (other.downloadUrl ?? null)
      && (attachment.previewUrl ?? null) === (other.previewUrl ?? null)
      && (attachment.localPath ?? null) === (other.localPath ?? null);
  });
}

export function normalizeCloudReaderAccountIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.flatMap((accountId) => (
    typeof accountId === 'string' && accountId.trim() ? [accountId.trim()] : []
  )))].sort();
}

function cloudReaderAccountIdsEqual(left?: string[], right?: string[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length
    && left.every((accountId, index) => accountId === right[index]);
}

function mergeCloudReaderAccountIds(current?: string[], incoming?: string[]): string[] | undefined {
  if (current === undefined && incoming === undefined) return undefined;
  return normalizeCloudReaderAccountIds([...(current ?? []), ...(incoming ?? [])]);
}

function cloudReactionsEqual(left: CloudMessage['reactions'] = [], right: CloudMessage['reactions'] = []) {
  if (left.length !== right.length) return false;
  return left.every((reaction, index) => {
    const other = right[index];
    return Boolean(other)
      && reaction.value === other.value
      && cloudReaderAccountIdsEqual(reaction.accountIds, other.accountIds);
  });
}

function cloudVoiceMessagesEqual(left: CloudMessage['voiceMessage'], right: CloudMessage['voiceMessage']) {
  if (!left || !right) return left === right;
  return left.mediaId === right.mediaId
    && left.mimeType === right.mimeType
    && left.durationMs === right.durationMs
    && left.transcript === right.transcript
    && left.waveformSamples.length === right.waveformSamples.length
    && left.waveformSamples.every((sample, index) => sample === right.waveformSamples[index]);
}

export function cloudMessagesEqual(
  message: CloudMessage,
  other: CloudMessage | undefined,
): boolean {
  if (!other) return false;
  return message.messageId === other.messageId
    && message.fromAccountId === other.fromAccountId
    && message.toAccountId === other.toAccountId
    && message.body === other.body
    && message.createdAt === other.createdAt
    && message.deliveredAt === other.deliveredAt
    && message.readAt === other.readAt
    && cloudReaderAccountIdsEqual(message.readByAccountIds, other.readByAccountIds)
    && message.direction === other.direction
    && (message.sessionId ?? null) === (other.sessionId ?? null)
    && (message.conversationId ?? null) === (other.conversationId ?? null)
    && (message.conversationSequence ?? null) === (other.conversationSequence ?? null)
    && (message.clientMessageId ?? null) === (other.clientMessageId ?? null)
    && (message.messageKind ?? null) === (other.messageKind ?? null)
    && cloudVoiceMessagesEqual(message.voiceMessage, other.voiceMessage)
    && (message.canonicalHistoryLocalMessageId ?? null) === (other.canonicalHistoryLocalMessageId ?? null)
    && (message.version ?? null) === (other.version ?? null)
    && cloudReactionsEqual(message.reactions, other.reactions)
    && cloudMessageAttachmentsEqual(message.attachments, other.attachments);
}

export function compareCloudMessages(left: CloudMessage, right: CloudMessage): number {
  const sameConversation = Boolean(
    left.sessionId
    && right.sessionId
    && left.sessionId === right.sessionId,
  );
  if (sameConversation) {
    const leftSequence = left.conversationSequence;
    const rightSequence = right.conversationSequence;
    const leftIsCanonical = Number.isSafeInteger(leftSequence) && Number(leftSequence) > 0;
    const rightIsCanonical = Number.isSafeInteger(rightSequence) && Number(rightSequence) > 0;
    if (leftIsCanonical && rightIsCanonical && leftSequence !== rightSequence) {
      return Number(leftSequence) - Number(rightSequence);
    }
    if (leftIsCanonical !== rightIsCanonical) return leftIsCanonical ? -1 : 1;
  }
  return left.createdAt.localeCompare(right.createdAt)
    || left.messageId.localeCompare(right.messageId);
}

export function mergeCloudMessageMonotonicState(
  current: CloudMessage,
  incoming: CloudMessage,
): CloudMessage {
  const incomingIsOlder = current.version != null
    && incoming.version != null
    && incoming.version < current.version;
  const merged = {
    ...current,
    ...(incomingIsOlder ? {} : incoming),
    attachments: incomingIsOlder
      ? current.attachments
      : incoming.attachments ?? current.attachments,
    voiceMessage: incomingIsOlder
      ? current.voiceMessage
      : incoming.voiceMessage ?? current.voiceMessage,
    deliveredAt: latestCloudReceiptAt(current.deliveredAt, incoming.deliveredAt),
    readAt: latestCloudReceiptAt(current.readAt, incoming.readAt),
    readByAccountIds: mergeCloudReaderAccountIds(
      current.readByAccountIds,
      incoming.readByAccountIds,
    ),
    reactions: incomingIsOlder
      ? current.reactions
      : incoming.reactions ?? current.reactions,
  };
  return cloudMessagesEqual(current, merged) ? current : merged;
}

export function upsertCloudMessage(
  messages: CloudMessage[],
  nextMessage: CloudMessage,
): CloudMessage[] {
  const index = messages.findIndex((message) => message.messageId === nextMessage.messageId);
  if (index >= 0) {
    const mergedMessage = mergeCloudMessageMonotonicState(messages[index], nextMessage);
    if (mergedMessage === messages[index]) return messages;
    const merged = messages.slice();
    merged[index] = mergedMessage;
    return sortCloudMessages(merged);
  }
  return sortCloudMessages([...messages, nextMessage]);
}

function sortCloudMessages(messages: CloudMessage[]): CloudMessage[] {
  return messages.sort(compareCloudMessages);
}
