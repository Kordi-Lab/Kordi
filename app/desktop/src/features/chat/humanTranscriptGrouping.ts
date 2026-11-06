import type { Message } from '@/kordi-app/types';

// Consecutive bubbles from the same person join into one group unless a time
// separator sits between them; agent turns and system rows never group.
function humanTranscriptGroupKey(message?: Message) {
  if (
    !message
    || message.role === 'system'
    || message.role === 'action'
    || message.role === 'edit'
    || message.turn
  ) return null;
  const senderType = message.senderType
    ?? (message.role === 'user' || message.role === 'person' ? 'human' : 'agent');
  const isOwnHuman = (message.isOwnMessage ?? message.role === 'user') && senderType === 'human';
  const isPeerHuman = !isOwnHuman && (senderType === 'human' || message.role === 'person');
  if (!isOwnHuman && !isPeerHuman) return null;
  const side = isOwnHuman ? 'own' : 'peer';
  const senderKey = message.senderAvatarSeed?.trim()
    || message.senderProfileImageUrl?.trim()
    || message.sender?.trim()
    || side;
  return `${side}:${senderKey}`;
}

export function isGroupedWithAdjacentHumanMessage(
  messages: readonly Message[],
  index: number,
  offset: -1 | 1,
  timeSeparators: readonly (string | null)[] = [],
) {
  if (offset === -1 && timeSeparators[index]) return false;
  if (offset === 1 && timeSeparators[index + 1]) return false;
  const currentKey = humanTranscriptGroupKey(messages[index]);
  return Boolean(currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]));
}
