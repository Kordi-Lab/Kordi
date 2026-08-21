import type { Message } from '@/kordi-app/types';

export function messageResponseText(message: Message) {
  return message.turn?.assistantText.trim()
    || message.turn?.error?.trim()
    || message.text.trim();
}

export function comparableAgentResponseText(value: string) {
  return value.trim().replace(/\s+/gu, '');
}

export function sameAgentResponseText(left: string, right: string) {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  return leftTrimmed === rightTrimmed
    || comparableAgentResponseText(leftTrimmed) === comparableAgentResponseText(rightTrimmed);
}

export function runtimeTranscriptAnchorKey(message: Message) {
  const text = messageResponseText(message).replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!text) return null;
  return [message.role, ...(message.role === 'owned-agent' ? [] : [message.time.trim()]), text].join('\u0000');
}

export function firstIndexGreaterThan(sortedValues: readonly number[], target: number) {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sortedValues[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function firstUnusedCanonicalIndex(
  candidates: readonly number[],
  startIndex: number,
  usedCanonicalIndexes: ReadonlySet<number>,
) {
  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!usedCanonicalIndexes.has(candidate)) return { candidate, nextCursor: index + 1 };
  }
  return null;
}

export function anchorUnmatchedFailedRuntimeMessages(
  runtimeMessages: Message[],
  canonicalMessages: Message[],
  runtimeAnchorIndexes: Array<number | null>,
  usedCanonicalIndexes: Set<number>,
) {
  for (let runtimeIndex = 0; runtimeIndex < runtimeMessages.length; runtimeIndex += 1) {
    const runtimeMessage = runtimeMessages[runtimeIndex];
    if (
      runtimeAnchorIndexes[runtimeIndex] !== null
      || runtimeMessage.role !== 'owned-agent'
      || runtimeMessage.turn?.completed !== true
      || runtimeMessage.turn.succeeded
    ) continue;
    let previousUserIndex = runtimeIndex - 1;
    while (previousUserIndex >= 0 && runtimeMessages[previousUserIndex]?.role !== 'user') {
      previousUserIndex -= 1;
    }
    const lowerBound = previousUserIndex >= 0 ? runtimeAnchorIndexes[previousUserIndex] : null;
    if (lowerBound === null) continue;
    let nextUserIndex = runtimeIndex + 1;
    while (nextUserIndex < runtimeMessages.length && runtimeMessages[nextUserIndex]?.role !== 'user') {
      nextUserIndex += 1;
    }
    const upperBound = nextUserIndex < runtimeMessages.length
      ? runtimeAnchorIndexes[nextUserIndex]
      : canonicalMessages.length;
    if (upperBound === null) continue;
    const candidates = canonicalMessages.flatMap((message, canonicalIndex) => (
      canonicalIndex > lowerBound
      && canonicalIndex < upperBound
      && !usedCanonicalIndexes.has(canonicalIndex)
      && message.role === 'owned-agent'
        ? [canonicalIndex]
        : []
    ));
    if (candidates.length !== 1) continue;
    runtimeAnchorIndexes[runtimeIndex] = candidates[0];
    usedCanonicalIndexes.add(candidates[0]);
  }
}
