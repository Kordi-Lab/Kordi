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

type RequestCandidate = {
  messageId: string;
  message: Message;
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

function normalizedToken(value?: string | null) {
  return cleanText(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function compactUnique(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = cleanText(value);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    result.push(cleaned);
  });
  return result;
}

function messageSourceLookupIds(message: Message, messageId: string) {
  return compactUnique([messageId, ...(message.replyAliasIds ?? [])]);
}

function mentionTargetsForRequest(message: Message) {
  const fromStructuredMentions = (message.mentions ?? []).map((mention) => mention.label);
  const fromTextMentions = [...message.text.matchAll(/@([^\s:;,.!?，。；：！？)\]}]+)/gu)].map((match) => match[1]);
  return new Set(
    [...fromStructuredMentions, ...fromTextMentions]
      .map(normalizedToken)
      .filter(Boolean),
  );
}

function agentTargetAliases(message: Message | DesktopChatTurnSnapshot) {
  const role = 'role' in message ? message.role : undefined;
  const sender = 'sender' in message ? message.sender : undefined;
  const aliases = new Set<string>();
  const senderAlias = normalizedToken(sender);
  if (senderAlias) aliases.add(senderAlias);

  if (role === 'owned-agent' || senderAlias === 'kordi' || senderAlias === 'mykordi') {
    aliases.add('kordi');
    aliases.add('mykordi');
  }

  return aliases;
}

function requestMentionsAgent(request: Message, agentMessage: Message) {
  const mentionTargets = mentionTargetsForRequest(request);
  if (mentionTargets.size === 0) return false;
  const agentAliases = agentTargetAliases(agentMessage);
  for (const mentionTarget of mentionTargets) {
    if (agentAliases.has(mentionTarget)) return true;
  }
  return false;
}

function isLocalAgentResponseMessage(message: Message) {
  const aliases = agentTargetAliases(message);
  return message.role === 'owned-agent' || aliases.has('kordi') || aliases.has('mykordi');
}

function inferredReplyTargetForAgentMessage(
  message: Message,
  requestCandidates: readonly RequestCandidate[],
  inferLatestHumanRequest: boolean,
) {
  const latestPlainRequest = latestOwnPlainRequest(requestCandidates);
  if (latestPlainRequest && (inferLatestHumanRequest || isLocalAgentResponseMessage(message))) {
    return latestPlainRequest.messageId;
  }

  for (let index = requestCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = requestCandidates[index];
    if (requestMentionsAgent(candidate.message, message)) return candidate.messageId;
  }

  return inferLatestHumanRequest ? requestCandidates[requestCandidates.length - 1]?.messageId ?? null : null;
}

function comparablePromptText(value?: string | null) {
  return cleanText(value)
    .replace(/^@(?:my\s*kordi|mykordi|kordi)\b\s*[:;,.!?—-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function requestMentionsLocalAgent(message: Message) {
  const mentionTargets = mentionTargetsForRequest(message);
  return mentionTargets.has('kordi') || mentionTargets.has('mykordi');
}

function latestOwnPlainRequest(requestCandidates: readonly RequestCandidate[]) {
  const latest = requestCandidates[requestCandidates.length - 1] ?? null;
  if (!latest) return null;
  const own = latest.message.isOwnMessage ?? latest.message.role === 'user';
  return own && mentionTargetsForRequest(latest.message).size === 0 ? latest : null;
}

function inferredReplyTargetForLiveTurn(
  liveTurn: DesktopChatTurnSnapshot,
  requestCandidates: readonly RequestCandidate[],
  inferLatestHumanRequest: boolean,
) {
  const promptText = comparablePromptText(liveTurn.prompt);
  if (promptText) {
    for (let index = requestCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = requestCandidates[index];
      if (comparablePromptText(candidate.message.text) === promptText) return candidate.messageId;
    }
  }

  if (!inferLatestHumanRequest) return null;

  const latestPlainRequest = latestOwnPlainRequest(requestCandidates);
  if (latestPlainRequest) return latestPlainRequest.messageId;

  for (let index = requestCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = requestCandidates[index];
    if (requestMentionsLocalAgent(candidate.message)) return candidate.messageId;
  }

  return inferLatestHumanRequest ? requestCandidates[requestCandidates.length - 1]?.messageId ?? null : null;
}

function replyTargetForMessage(
  message: Message,
  requestCandidates: readonly RequestCandidate[],
  inferLatestHumanRequest: boolean,
  sourceByMessageId: ReadonlyMap<string, MessageSourceReference>,
) {
  const explicitTarget = explicitReplyTargetForMessage(message);
  if (explicitTarget && sourceByMessageId.has(explicitTarget)) return explicitTarget;
  return inferredReplyTargetForAgentMessage(message, requestCandidates, inferLatestHumanRequest);
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
  const requestCandidates: RequestCandidate[] = [];

  const messagesWithIds = inputMessages.map((message, index) => {
    const messageId = messageIds[index];
    const withId = message.id === messageId ? message : { ...message, id: messageId };
    if (isHumanRequest(withId)) {
      const sourceReference = sourceReferenceForMessage(withId, messageId);
      messageSourceLookupIds(withId, messageId).forEach((lookupId) => {
        if (!sourceByMessageId.has(lookupId)) sourceByMessageId.set(lookupId, sourceReference);
      });
    }
    return withId;
  });

  const linkedMessages = messagesWithIds.map((message, index) => {
    const messageId = messageIds[index];
    if (isHumanRequest(message)) {
      requestCandidates.push({ messageId, message });
      return message;
    }
    if (!isAgentResponse(message)) return message;

    const replyTargetId = replyTargetForMessage(message, requestCandidates, inferLatestHumanRequest, sourceByMessageId);
    if (!replyTargetId) return message;
    const sourceMessage = sourceByMessageId.get(replyTargetId);
    if (!sourceMessage) return message;

    addReplySummary(summariesByRequestId, sourceMessage.messageId, messageId, completedReplyCountable(message));
    return withSourceMessage({ ...message, replyToMessageId: sourceMessage.messageId }, sourceMessage);
  });

  const linkedLiveTurn = (() => {
    if (!liveTurn) return undefined;
    const explicitTargetId = explicitReplyTargetForTurn(liveTurn);
    const replyTargetId = explicitTargetId ?? inferredReplyTargetForLiveTurn(liveTurn, requestCandidates, inferLatestHumanRequest);
    if (!replyTargetId) return liveTurn;
    const sourceMessage = sourceByMessageId.get(replyTargetId);
    if (!sourceMessage) return liveTurn;
    addReplySummary(summariesByRequestId, sourceMessage.messageId, liveTurn.id, liveTurn.completed);
    return {
      ...liveTurn,
      replyToMessageId: sourceMessage.messageId,
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
