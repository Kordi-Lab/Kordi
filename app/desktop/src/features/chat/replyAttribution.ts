import type {
  Conversation,
  DesktopChatTurnSnapshot,
  Message,
  MessageReplySummary,
  MessageSourceReference,
} from '@/kordi-app/types';

export type ReplyAttributionResult = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot;
};

function cleanText(value?: string | null) {
  return value?.trim() ?? '';
}

function messageIdFor(message: Message, index: number) {
  return cleanText(message.id) || `transcript-message:${index}`;
}

function isHumanRequest(message: Message) {
  const senderType = message.senderType ?? (message.role === 'user' || message.role === 'person' ? 'human' : undefined);
  const hasContent = message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
  return hasContent && senderType === 'human' && (message.role === 'user' || message.role === 'person');
}

function isAgentResponse(message: Message) {
  return Boolean(message.turn) && (message.senderType === 'agent' || message.role === 'owned-agent' || message.role === 'external-agent');
}

function sourceReferenceForMessage(message: Message, messageId: string): MessageSourceReference {
  return {
    messageId,
    senderLabel: message.sender ?? (message.isOwnMessage ? 'You' : null),
    text: message.text,
    attachmentCount: message.attachments?.length ?? 0,
    time: message.time,
  };
}

function explicitReplyTargetForMessage(message: Message) {
  return cleanText(message.replyToMessageId)
    || cleanText(message.turn?.replyToMessageId)
    || cleanText(message.sourceMessage?.messageId)
    || cleanText(message.turn?.sourceMessage?.messageId)
    || null;
}

function explicitReplyTargetForTurn(turn: DesktopChatTurnSnapshot) {
  return cleanText(turn.replyToMessageId)
    || cleanText(turn.sourceMessage?.messageId)
    || null;
}

function replyTargetForMessage(message: Message, latestRequestId: string | null, inferLatestHumanRequest: boolean) {
  return explicitReplyTargetForMessage(message) ?? (inferLatestHumanRequest ? latestRequestId : null);
}

function completedReplyCountable(message: Message) {
  if (!message.turn) return true;
  return message.turn.completed;
}

function addReplySummary(
  summaries: Map<string, MessageReplySummary>,
  requestId: string,
  responseId: string,
  completed: boolean,
) {
  const current = summaries.get(requestId) ?? { replyCount: 0, pending: false, targetMessageId: null };
  summaries.set(requestId, {
    replyCount: current.replyCount + (completed ? 1 : 0),
    pending: current.pending || !completed,
    targetMessageId: current.targetMessageId ?? responseId,
  });
}

function withSourceMessage(message: Message, sourceMessage: MessageSourceReference) {
  return {
    ...message,
    sourceMessage: message.sourceMessage ?? sourceMessage,
    turn: message.turn
      ? {
          ...message.turn,
          sourceMessage: message.turn.sourceMessage ?? sourceMessage,
        }
      : message.turn,
  };
}

export function shouldInferLatestHumanReplyTarget(
  conversation: Pick<Conversation, 'type' | 'participantSpaceId' | 'canonicalParticipantCount' | 'canonicalParticipants'> | null | undefined,
) {
  if (!conversation) return false;
  if (conversation.type === 'person' || conversation.type === 'external-agent') return true;
  if (conversation.participantSpaceId?.trim()) return true;
  const participantCount = conversation.canonicalParticipantCount ?? conversation.canonicalParticipants?.length ?? 0;
  return participantCount > 2;
}

export function replyStatusText(summary: MessageReplySummary | null | undefined) {
  if (!summary) return '';
  const count = Math.max(0, summary.replyCount);
  const replyText = count > 0 ? `${count} ${count === 1 ? 'reply' : 'replies'}` : '';
  if (replyText && summary.pending) return `${replyText} · replying…`;
  if (replyText) return replyText;
  return summary.pending ? 'Replying…' : '';
}

export function buildReplyAttribution(
  inputMessages: readonly Message[],
  liveTurn?: DesktopChatTurnSnapshot | null,
  options: { inferLatestHumanRequest?: boolean } = {},
): ReplyAttributionResult {
  const inferLatestHumanRequest = Boolean(options.inferLatestHumanRequest);
  const sourceByMessageId = new Map<string, MessageSourceReference>();
  const summariesByRequestId = new Map<string, MessageReplySummary>();
  const messageIds = inputMessages.map(messageIdFor);
  let latestRequestId: string | null = null;

  const messagesWithIds = inputMessages.map((message, index) => {
    const messageId = messageIds[index];
    const withId = message.id === messageId ? message : { ...message, id: messageId };
    if (isHumanRequest(withId)) {
      latestRequestId = messageId;
      sourceByMessageId.set(messageId, sourceReferenceForMessage(withId, messageId));
    }
    return withId;
  });

  latestRequestId = null;
  const linkedMessages = messagesWithIds.map((message, index) => {
    const messageId = messageIds[index];
    if (isHumanRequest(message)) {
      latestRequestId = messageId;
      return message;
    }
    if (!isAgentResponse(message)) return message;

    const replyToMessageId = replyTargetForMessage(message, latestRequestId, inferLatestHumanRequest);
    if (!replyToMessageId) return message;
    const sourceMessage = sourceByMessageId.get(replyToMessageId);
    if (!sourceMessage) return message;

    addReplySummary(summariesByRequestId, replyToMessageId, messageId, completedReplyCountable(message));
    return withSourceMessage({ ...message, replyToMessageId }, sourceMessage);
  });

  const linkedLiveTurn = (() => {
    if (!liveTurn) return undefined;
    const replyToMessageId = explicitReplyTargetForTurn(liveTurn) ?? (inferLatestHumanRequest ? latestRequestId : null);
    if (!replyToMessageId) return liveTurn;
    const sourceMessage = sourceByMessageId.get(replyToMessageId);
    if (!sourceMessage) return liveTurn;
    addReplySummary(summariesByRequestId, replyToMessageId, liveTurn.id, liveTurn.completed);
    return {
      ...liveTurn,
      replyToMessageId,
      sourceMessage: liveTurn.sourceMessage ?? sourceMessage,
    };
  })();

  const messages = linkedMessages.map((message) => {
    const messageId = cleanText(message.id);
    const summary = messageId ? summariesByRequestId.get(messageId) : undefined;
    return summary ? { ...message, replySummary: summary } : message;
  });

  return { messages, liveTurn: linkedLiveTurn };
}
