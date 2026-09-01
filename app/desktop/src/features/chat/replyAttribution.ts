import { isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
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
  const responseText = cleanText(message.turn?.assistantText)
    || cleanText(message.turn?.error)
    || cleanText(message.text);
  return {
    messageId,
    senderLabel: message.sender ?? (message.isOwnMessage ? 'You' : null),
    text: responseText,
    mentions: message.mentions,
    attachmentCount: message.attachments?.length ?? 0,
    time: message.time,
  };
}

function explicitReplyTargetForMessage(message: Message) {
  if (message.messageAction?.kind === 'thread') return null;
  const explicitReplyId = cleanText(message.replyToMessageId)
    || cleanText(message.turn?.replyToMessageId);
  if (explicitReplyId) return explicitReplyId;

  if (message.messageAction?.kind === 'forward') return null;

  return cleanText(message.sourceMessage?.messageId)
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
  const requestText = cleanText(message.text) || cleanText(message.turn?.assistantText);
  const fromTextMentions = [...requestText.matchAll(/@([^\s:;,.!?，。；：！？)\]}]+)/gu)].map((match) => match[1]);
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
  mentionCandidates: readonly RequestCandidate[],
  inferLatestHumanRequest: boolean,
) {
  const latestPlainRequest = latestOwnPlainRequest(requestCandidates);
  if (latestPlainRequest && (inferLatestHumanRequest || isLocalAgentResponseMessage(message))) {
    return latestPlainRequest.messageId;
  }

  for (let index = mentionCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = mentionCandidates[index];
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
  mentionCandidates: readonly RequestCandidate[],
  inferLatestHumanRequest: boolean,
  sourceByMessageId: ReadonlyMap<string, MessageSourceReference>,
) {
  const explicitTarget = explicitReplyTargetForMessage(message);
  if (explicitTarget && sourceByMessageId.has(explicitTarget)) return explicitTarget;
  return inferredReplyTargetForAgentMessage(
    message,
    requestCandidates,
    mentionCandidates,
    inferLatestHumanRequest,
  );
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

function withoutAgentReplyAttribution(message: Message): Message {
  if (!isAgentResponse(message)) return { ...message, replySummary: undefined };
  return {
    ...message,
    replyToMessageId: undefined,
    replySummary: undefined,
    sourceMessage: undefined,
    turn: message.turn
      ? {
          ...message.turn,
          replyToMessageId: undefined,
          sourceMessage: undefined,
        }
      : message.turn,
  };
}

function withoutLiveTurnReplyAttribution(turn: DesktopChatTurnSnapshot): DesktopChatTurnSnapshot {
  return {
    ...turn,
    replyToMessageId: undefined,
    sourceMessage: undefined,
  };
}

function agentReplyLifecycleKey(message: Message) {
  if (!isAgentResponse(message)) return null;
  const replyTargetId = explicitReplyTargetForMessage(message);
  if (!replyTargetId) return null;
  return [replyTargetId, message.role, normalizedToken(message.sender)].join('\u0000');
}

function noProviderReplyDedupeKey(message: Message, sourceMessage: MessageSourceReference) {
  const errorText = cleanText(message.turn?.error) || cleanText(message.text);
  if (!isCloudAgentNoProviderConfiguredError(errorText)) return null;
  return [
    sourceMessage.messageId,
    cleanText(message.sender),
    cleanText(message.senderType),
    cleanText(message.role),
    'no-provider',
  ].join('\u0000');
}

export function shouldInferLatestHumanReplyTarget(
  conversation:
    | Pick<
        Conversation,
        | 'type'
        | 'participantSpaceId'
        | 'canonicalParticipantCount'
        | 'canonicalParticipants'
        | 'forkedFromSessionId'
      >
    | null
    | undefined,
) {
  if (!conversation) return false;
  if (conversation.type === 'person' || conversation.type === 'external-agent') return true;
  if (conversation.participantSpaceId?.trim()) return true;
  // Forked group/contact sessions inherit a snapshot of their parent's
  // transcript; infer positional reply links there so group agent replies
  // retain their request context. Private self-agent forks already show the
  // user's new turn as the adjacent message, so adding a source quote repeats
  // the same text inside the assistant bubble.
  if (conversation.forkedFromSessionId?.trim()) return conversation.type !== 'owned-agent';
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

export function shouldSuppressAgentReplyAttribution(
  conversation:
    | Pick<
        Conversation,
        | 'id'
        | 'canonicalSessionId'
        | 'type'
        | 'participantSpaceId'
        | 'canonicalParticipantCount'
        | 'canonicalParticipants'
        | 'forkedFromSessionId'
      >
    | null
    | undefined,
) {
  if (!conversation || conversation.type !== 'owned-agent') return false;
  const sessionId = (conversation.canonicalSessionId || conversation.id).trim();
  const forkParentId = conversation.forkedFromSessionId?.trim() ?? '';
  return !['session:group:', 'session:project:'].some((prefix) => (
    sessionId.startsWith(prefix) || forkParentId.startsWith(prefix)
  ));
}

export function buildReplyAttribution(
  inputMessages: readonly Message[],
  liveTurn?: DesktopChatTurnSnapshot | null,
  options: {
    inferLatestHumanRequest?: boolean;
    suppressAgentReplyAttribution?: boolean;
    messageIndexOffset?: number;
  } = {},
): ReplyAttributionResult {
  const inferLatestHumanRequest = Boolean(options.inferLatestHumanRequest);
  const suppressAgentReplyAttribution = Boolean(options.suppressAgentReplyAttribution);
  const messageIndexOffset = Number.isFinite(options.messageIndexOffset) ? Math.max(0, Math.floor(options.messageIndexOffset ?? 0)) : 0;
  const sourceByMessageId = new Map<string, MessageSourceReference>();
  const summariesByRequestId = new Map<string, MessageReplySummary>();
  const messageIds = inputMessages.map((message, index) => messageIdFor(message, index + messageIndexOffset));
  const requestCandidates: RequestCandidate[] = [];
  const mentionCandidates: RequestCandidate[] = [];

  const messagesWithIds = inputMessages.map((message, index) => {
    const messageId = messageIds[index];
    const withId = message.id === messageId ? message : { ...message, id: messageId };
    const sourceReference = sourceReferenceForMessage(withId, messageId);
    if (
      withId.role !== 'system'
      && (sourceReference.text.length > 0 || (sourceReference.attachmentCount ?? 0) > 0)
    ) {
      messageSourceLookupIds(withId, messageId).forEach((lookupId) => {
        if (!sourceByMessageId.has(lookupId)) sourceByMessageId.set(lookupId, sourceReference);
      });
    }
    return withId;
  });
  const completedReplyKeys = new Set(messagesWithIds.flatMap((message) => {
    const key = message.turn?.completed ? agentReplyLifecycleKey(message) : null;
    return key ? [key] : [];
  }));

  const seenNoProviderReplyKeys = new Set<string>();
  const linkedMessages = messagesWithIds.map((message, index) => {
    const messageId = messageIds[index];
    if (isHumanRequest(message)) {
      requestCandidates.push({ messageId, message });
      mentionCandidates.push({ messageId, message });
      const explicitTarget = explicitReplyTargetForMessage(message);
      const sourceMessage = explicitTarget ? sourceByMessageId.get(explicitTarget) : undefined;
      if (sourceMessage && sourceMessage.messageId !== messageId) {
        addReplySummary(summariesByRequestId, sourceMessage.messageId, messageId, true);
        return withSourceMessage({ ...message, replyToMessageId: sourceMessage.messageId }, sourceMessage);
      }
      return message;
    }
    if (!isAgentResponse(message)) return message;

    const replyTargetId = replyTargetForMessage(
      message,
      requestCandidates,
      mentionCandidates,
      inferLatestHumanRequest,
      sourceByMessageId,
    );
    mentionCandidates.push({ messageId, message });
    if (!replyTargetId) return suppressAgentReplyAttribution ? withoutAgentReplyAttribution(message) : message;
    const sourceMessage = sourceByMessageId.get(replyTargetId);
    if (!sourceMessage) return suppressAgentReplyAttribution ? withoutAgentReplyAttribution(message) : message;

    const noProviderDedupeKey = noProviderReplyDedupeKey(message, sourceMessage);
    if (noProviderDedupeKey) {
      if (seenNoProviderReplyKeys.has(noProviderDedupeKey)) return null;
      seenNoProviderReplyKeys.add(noProviderDedupeKey);
    }

    const attributedMessage = withSourceMessage({ ...message, replyToMessageId: sourceMessage.messageId }, sourceMessage);
    const replyKey = agentReplyLifecycleKey(attributedMessage);
    if (message.turn && !message.turn.completed && replyKey && completedReplyKeys.has(replyKey)) return null;
    if (suppressAgentReplyAttribution) return withoutAgentReplyAttribution(message);
    addReplySummary(summariesByRequestId, sourceMessage.messageId, messageId, completedReplyCountable(message));
    return attributedMessage;
  }).filter((message): message is Message => Boolean(message));

  const linkedLiveTurn = (() => {
    if (!liveTurn) return undefined;
    const explicitTargetId = explicitReplyTargetForTurn(liveTurn);
    const replyTargetId = explicitTargetId ?? inferredReplyTargetForLiveTurn(liveTurn, requestCandidates, inferLatestHumanRequest);
    if (!replyTargetId) return suppressAgentReplyAttribution ? withoutLiveTurnReplyAttribution(liveTurn) : liveTurn;
    const sourceMessage = sourceByMessageId.get(replyTargetId);
    if (!sourceMessage) return suppressAgentReplyAttribution ? withoutLiveTurnReplyAttribution(liveTurn) : liveTurn;
    if (suppressAgentReplyAttribution) return withoutLiveTurnReplyAttribution(liveTurn);
    addReplySummary(summariesByRequestId, sourceMessage.messageId, liveTurn.id, liveTurn.completed);
    return {
      ...liveTurn,
      replyToMessageId: sourceMessage.messageId,
      sourceMessage: liveTurn.sourceMessage ?? sourceMessage,
    };
  })();

  const messages = suppressAgentReplyAttribution
    ? linkedMessages.map(withoutAgentReplyAttribution)
    : linkedMessages.map((message) => {
        const messageId = cleanText(message.id);
        const summary = messageId ? summariesByRequestId.get(messageId) : undefined;
        return summary ? { ...message, replySummary: summary } : message;
      });

  return { messages, liveTurn: linkedLiveTurn };
}
