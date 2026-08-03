import type { Conversation, Message } from '@/kordi-app/types';

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && jsonValuesEqual(leftRecord[key], rightRecord[key])
  ));
}

function stableMessageIdentityKeys(message: Message) {
  return [
    message.id?.trim() ? `id:${message.id.trim()}` : '',
    message.entryId?.trim() ? `entry:${message.entryId.trim()}` : '',
    message.turn?.transcriptEntryId?.trim()
      ? `turn-entry:${message.turn.transcriptEntryId.trim()}`
      : '',
  ].filter(Boolean);
}

function fallbackMessageIdentityKey(message: Message) {
  return [
    'fallback',
    message.role,
    message.senderIdentityId?.trim() ?? '',
    message.sender?.trim() ?? '',
    message.time.trim(),
    message.text.trim(),
    message.turn?.assistantText.trim() ?? '',
    message.turn?.error?.trim() ?? '',
    message.detail?.trim() ?? '',
  ].join('\u0000');
}

function messageIdentityKeys(message: Message) {
  const stableKeys = stableMessageIdentityKeys(message);
  return stableKeys.length > 0 ? stableKeys : [fallbackMessageIdentityKey(message)];
}

function previousMessageIndexesByIdentity(messages: readonly Message[]) {
  const indexesByIdentity = new Map<string, number[]>();
  messages.forEach((message, index) => {
    for (const identity of messageIdentityKeys(message)) {
      const indexes = indexesByIdentity.get(identity);
      if (indexes) indexes.push(index);
      else indexesByIdentity.set(identity, [index]);
    }
  });
  return indexesByIdentity;
}

function equivalentPreviousMessageIndex(
  message: Message,
  previousMessages: readonly Message[],
  previousIndexesByIdentity: ReadonlyMap<string, readonly number[]>,
  usedPreviousIndexes: ReadonlySet<number>,
  candidateCursorByIdentity: Map<string, number>,
) {
  for (const identity of messageIdentityKeys(message)) {
    const candidates = previousIndexesByIdentity.get(identity) ?? [];
    for (
      let candidatePosition = candidateCursorByIdentity.get(identity) ?? 0;
      candidatePosition < candidates.length;
      candidatePosition += 1
    ) {
      candidateCursorByIdentity.set(identity, candidatePosition + 1);
      const previousIndex = candidates[candidatePosition];
      if (usedPreviousIndexes.has(previousIndex)) continue;
      if (jsonValuesEqual(previousMessages[previousIndex], message)) return previousIndex;
    }
  }
  return null;
}

/**
 * Reuses committed message objects when hydration or native remapping returns
 * the same transcript values. This keeps virtual row measurement and memoized
 * message rendering stable while still accepting real edits and new rows.
 */
export function preserveEquivalentTranscriptMessageReferences(
  previousMessages: readonly Message[] | undefined,
  nextMessages: Message[],
) {
  if (!previousMessages || previousMessages.length === 0 || previousMessages === nextMessages) {
    return nextMessages;
  }

  const previousIndexesByIdentity = previousMessageIndexesByIdentity(previousMessages);
  const usedPreviousIndexes = new Set<number>();
  const candidateCursorByIdentity = new Map<string, number>();
  let reusedAnyMessage = false;
  const reconciled = nextMessages.map((message) => {
    const previousIndex = equivalentPreviousMessageIndex(
      message,
      previousMessages,
      previousIndexesByIdentity,
      usedPreviousIndexes,
      candidateCursorByIdentity,
    );
    if (previousIndex === null) return message;
    usedPreviousIndexes.add(previousIndex);
    reusedAnyMessage = true;
    return previousMessages[previousIndex];
  });

  if (
    previousMessages.length === reconciled.length
    && reconciled.every((message, index) => message === previousMessages[index])
  ) {
    return previousMessages as Message[];
  }
  return reusedAnyMessage ? reconciled : nextMessages;
}

export type TranscriptReferenceCache = ReadonlyMap<string, readonly Message[]>;

export type TranscriptReferenceStabilizer = {
  prepare: (conversations: Conversation[]) => ReturnType<typeof preserveConversationTranscriptReferences>;
  commit: (cache: TranscriptReferenceCache) => void;
};

function conversationTranscriptKey(conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>) {
  return conversation.canonicalSessionId?.trim() || conversation.id;
}

/**
 * Reconciles all transcript arrays without allowing rows from one session to
 * leak into another. The returned cache contains only currently known chats,
 * so archived/removed sessions do not accumulate in memory.
 */
export function preserveConversationTranscriptReferences(
  conversations: Conversation[],
  previousBySession: TranscriptReferenceCache,
) {
  const nextBySession = new Map<string, readonly Message[]>();
  let changed = false;
  const reconciled = conversations.map((conversation) => {
    const key = conversationTranscriptKey(conversation);
    const messages = preserveEquivalentTranscriptMessageReferences(
      previousBySession.get(key),
      conversation.messages,
    );
    nextBySession.set(key, messages);
    if (messages === conversation.messages) return conversation;
    changed = true;
    return { ...conversation, messages };
  });

  return {
    conversations: changed ? reconciled : conversations,
    cache: nextBySession,
  };
}

/**
 * Keeps render preparation pure with respect to the last committed UI. A
 * concurrent render may prepare a candidate cache, but only a layout effect
 * commits it after React accepts that render.
 */
export function createTranscriptReferenceStabilizer(): TranscriptReferenceStabilizer {
  let committedCache: TranscriptReferenceCache = new Map();
  return {
    prepare(conversations) {
      return preserveConversationTranscriptReferences(conversations, committedCache);
    },
    commit(cache) {
      committedCache = cache;
    },
  };
}
