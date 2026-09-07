import type {
Message
} from '@/kordi-app/types';
import { mergedMessageReactionMetadata } from "./readModel/messageReactionMetadata";
import {
anchorUnmatchedFailedRuntimeMessages,
firstIndexGreaterThan,
firstUnusedCanonicalIndex,
runtimeTranscriptAnchorKey
} from "./readModel/runtimeMessageMatching";

export function mergeCanonicalHistoryIntoRuntime(
  canonicalMessages: Message[],
  runtimeMessages: Message[],
) {
  const runtimeMessageIds = new Set(runtimeMessages.flatMap((message) => (
    [message.id, message.entryId].filter((value): value is string => Boolean(value?.trim()))
  )));
  const canonicalIndexesById = new Map<string, number>();
  const canonicalIndexesByAnchor = new Map<string, number[]>();
  canonicalMessages.forEach((message, canonicalIndex) => {
    if (message.messageAction?.kind === 'forward') return;
    for (const id of [message.id, message.entryId]) {
      if (id?.trim()) canonicalIndexesById.set(id, canonicalIndex);
    }
    const anchorKey = runtimeTranscriptAnchorKey(message);
    if (!anchorKey) return;
    const indexes = canonicalIndexesByAnchor.get(anchorKey);
    if (indexes) indexes.push(canonicalIndex);
    else canonicalIndexesByAnchor.set(anchorKey, [canonicalIndex]);
  });

  const usedCanonicalIndexes = new Set<number>();
  const fallbackCursorByAnchor = new Map<string, number>();
  let lastCanonicalIndex = -1;
  const runtimeAnchorIndexes = runtimeMessages.map((message) => {
    let stableMatch: number | undefined;
    for (const id of [message.id, message.entryId]) {
      const canonicalIndex = id?.trim() ? canonicalIndexesById.get(id) : undefined;
      if (canonicalIndex !== undefined && !usedCanonicalIndexes.has(canonicalIndex)) {
        stableMatch = canonicalIndex;
        break;
      }
    }
    const anchorKey = runtimeTranscriptAnchorKey(message);
    const candidates = anchorKey ? canonicalIndexesByAnchor.get(anchorKey) ?? [] : [];
    const preferredMatch = stableMatch === undefined
      ? firstUnusedCanonicalIndex(
          candidates,
          firstIndexGreaterThan(candidates, lastCanonicalIndex),
          usedCanonicalIndexes,
        )
      : null;
    const fallbackMatch = stableMatch !== undefined || preferredMatch || !anchorKey
      ? null
      : firstUnusedCanonicalIndex(
          candidates,
          fallbackCursorByAnchor.get(anchorKey) ?? 0,
          usedCanonicalIndexes,
        );
    if (anchorKey && fallbackMatch) fallbackCursorByAnchor.set(anchorKey, fallbackMatch.nextCursor);
    const canonicalIndex = stableMatch
      ?? preferredMatch?.candidate
      ?? fallbackMatch?.candidate
      ?? null;
    if (canonicalIndex === null) return null;
    usedCanonicalIndexes.add(canonicalIndex);
    if (canonicalIndex > lastCanonicalIndex) lastCanonicalIndex = canonicalIndex;
    return canonicalIndex;
  });
  anchorUnmatchedFailedRuntimeMessages(
    runtimeMessages,
    canonicalMessages,
    runtimeAnchorIndexes,
    usedCanonicalIndexes,
  );
  const enrichedRuntimeMessages = runtimeMessages.map((message, runtimeIndex) => {
    const canonicalIndex = runtimeAnchorIndexes[runtimeIndex];
    if (canonicalIndex === null) return message;
    const canonicalMessage = canonicalMessages[canonicalIndex];
    const isForkSnapshot = canonicalMessage.isForkSnapshot;
    const runtimeAliasIds = message.replyAliasIds ?? [];
    const canonicalAliasIds = [canonicalMessage.id, canonicalMessage.entryId, ...(canonicalMessage.replyAliasIds ?? [])]
      .filter((value): value is string => Boolean(value?.trim()));
    const replyAliasIds = [...new Set([
      ...runtimeAliasIds,
      ...canonicalAliasIds,
    ])];
    const reactionMetadata = mergedMessageReactionMetadata(message, canonicalMessage);
    const senderOwnerName = canonicalMessage.senderOwnerName ?? message.senderOwnerName;
    const conversationSequence = canonicalMessage.conversationSequence ?? message.conversationSequence;
    if (!isForkSnapshot && replyAliasIds.length === runtimeAliasIds.length && !reactionMetadata.changed && senderOwnerName === message.senderOwnerName && conversationSequence === message.conversationSequence) {
      return message;
    }
    return {
      ...message,
      senderOwnerName,
      conversationSequence,
      ...(isForkSnapshot ? { isForkSnapshot: true } : {}),
      ...(replyAliasIds.length > 0 ? { replyAliasIds } : {}),
      ...reactionMetadata.values,
    };
  });

  const overlayMessages = canonicalMessages
    .map((message, canonicalIndex) => ({ message, canonicalIndex }))
    .filter(({ message, canonicalIndex }) => (
      !usedCanonicalIndexes.has(canonicalIndex)
      && ![message.id, message.entryId].some((value) => Boolean(value && runtimeMessageIds.has(value)))
    ));
  if (overlayMessages.length === 0) return enrichedRuntimeMessages;
  if (runtimeMessages.length === 0) return overlayMessages.map(({ message }) => message);

  const canonicalBeforeRuntimeIndex = Array.from(
    { length: enrichedRuntimeMessages.length + 1 },
    () => [] as Message[],
  );
  const matchedAnchors = runtimeAnchorIndexes.flatMap((canonicalIndex, runtimeIndex) => (
    canonicalIndex === null ? [] : [{ canonicalIndex, runtimeIndex }]
  )).sort((left, right) => left.canonicalIndex - right.canonicalIndex);
  const matchedCanonicalIndexes = matchedAnchors.map((anchor) => anchor.canonicalIndex);
  const prefixLatestRuntimeIndex = matchedAnchors.map((anchor) => anchor.runtimeIndex);
  for (let index = 1; index < prefixLatestRuntimeIndex.length; index += 1) {
    prefixLatestRuntimeIndex[index] = Math.max(prefixLatestRuntimeIndex[index - 1], prefixLatestRuntimeIndex[index]);
  }
  const suffixEarliestRuntimeIndex = matchedAnchors.map((anchor) => anchor.runtimeIndex);
  for (let index = suffixEarliestRuntimeIndex.length - 2; index >= 0; index -= 1) {
    suffixEarliestRuntimeIndex[index] = Math.min(suffixEarliestRuntimeIndex[index], suffixEarliestRuntimeIndex[index + 1]);
  }
  const unmatchedRuntimeIndexes = runtimeAnchorIndexes.flatMap((canonicalIndex, runtimeIndex) => (
    canonicalIndex === null ? [runtimeIndex] : []
  ));
  for (const { message, canonicalIndex } of overlayMessages) {
    const nextAnchorPosition = firstIndexGreaterThan(matchedCanonicalIndexes, canonicalIndex);
    const nextRuntimeIndex = suffixEarliestRuntimeIndex[nextAnchorPosition];
    if (nextRuntimeIndex !== undefined) {
      canonicalBeforeRuntimeIndex[nextRuntimeIndex].push(message);
      continue;
    }

    const lastEarlierRuntimeIndex = nextAnchorPosition > 0
      ? prefixLatestRuntimeIndex[nextAnchorPosition - 1]
      : -1;
    const unmatchedPosition = firstIndexGreaterThan(unmatchedRuntimeIndexes, lastEarlierRuntimeIndex);
    const targetIndex = unmatchedRuntimeIndexes[unmatchedPosition] ?? enrichedRuntimeMessages.length;
    canonicalBeforeRuntimeIndex[targetIndex].push(message);
  }

  return enrichedRuntimeMessages.flatMap((message, runtimeIndex) => [
    ...canonicalBeforeRuntimeIndex[runtimeIndex],
    message,
  ]).concat(canonicalBeforeRuntimeIndex[enrichedRuntimeMessages.length]);
}
