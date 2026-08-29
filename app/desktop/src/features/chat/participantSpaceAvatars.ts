import { groupParticipantStableKey } from './groupTitle';
import type { ConversationParticipant, ParticipantSpaceKind } from '@/kordi-app/types';

function isSelf(participant: ConversationParticipant) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

export function participantSpaceAvatarParticipants(
  kind: ParticipantSpaceKind,
  participants: ConversationParticipant[],
) {
  if (kind === 'self') {
    const primary = participants.find(isSelf)
      ?? participants.find((participant) => participant.kind === 'human')
      ?? participants[0];
    return primary ? [primary] : [];
  }
  if (kind !== 'group') {
    const primary = participants.find((participant) => !isSelf(participant));
    return primary ? [primary] : [];
  }
  return participants
    .filter((participant) => participant.kind === 'human')
    .sort((left, right) => (
      groupParticipantStableKey(left).localeCompare(groupParticipantStableKey(right))
    ))
    .slice(0, 3);
}
