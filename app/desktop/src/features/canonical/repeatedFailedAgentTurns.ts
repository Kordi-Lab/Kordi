import type { Message } from '@/kordi-app/types';

function messageReplyReferences(message: Message): string[] {
  return [...new Set([
    message.replyToMessageId,
    message.turn?.replyToMessageId,
    message.sourceMessage?.messageId,
    message.turn?.sourceMessage?.messageId,
  ].filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim()))];
}

function failedAgentTurn(message: Message) {
  return (
    message.role === 'owned-agent'
    || message.role === 'external-agent'
  )
    && message.turn?.completed === true
    && message.turn.status === 'failed';
}

function failedAgentSenderKey(message: Message) {
  if (message.role === 'owned-agent') return 'owned-agent:self';
  return [
    message.role,
    message.senderIdentityId?.trim() || message.sender?.trim() || 'agent',
  ].join(':');
}

export function dedupeRepeatedFailedAgentTurns(messages: Message[]) {
  const requestOwnerByAlias = new Map<string, string>();
  messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'person') return;
    const requestKey = message.id?.trim()
      || message.entryId?.trim()
      || `request:${index}`;
    for (const alias of [
      message.id,
      message.entryId,
      ...(message.replyAliasIds ?? []),
    ]) {
      const normalized = alias?.trim();
      if (normalized) requestOwnerByAlias.set(normalized, requestKey);
    }
  });

  const failureKey = (message: Message) => {
    if (!failedAgentTurn(message)) return null;
    const references = messageReplyReferences(message);
    const requestKey = references
      .map((reference) => requestOwnerByAlias.get(reference))
      .find(Boolean)
      ?? references[0];
    return requestKey
      ? `${failedAgentSenderKey(message)}\u0000${requestKey}`
      : null;
  };
  const preferredFailureIndexByKey = new Map<string, number>();
  messages.forEach((message, index) => {
    const key = failureKey(message);
    if (!key) return;
    const preferredIndex = preferredFailureIndexByKey.get(key);
    if (preferredIndex === undefined) {
      preferredFailureIndexByKey.set(key, index);
      return;
    }
    const preferred = messages[preferredIndex];
    const preferredAt = preferred.timestampMs ?? 0;
    const candidateAt = message.timestampMs ?? 0;
    if (candidateAt >= preferredAt) {
      preferredFailureIndexByKey.set(key, index);
    }
  });

  const targetedFailuresDeduped = messages.filter((message, index) => {
    const key = failureKey(message);
    return !key || preferredFailureIndexByKey.get(key) === index;
  });
  const deduped: Message[] = [];
  for (const message of targetedFailuresDeduped) {
    const previous = deduped[deduped.length - 1];
    if (
      previous
      && failedAgentTurn(previous)
      && failedAgentTurn(message)
      && failedAgentSenderKey(previous) === failedAgentSenderKey(message)
      && !failureKey(previous)
      && !failureKey(message)
    ) {
      deduped[deduped.length - 1] = message;
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}
