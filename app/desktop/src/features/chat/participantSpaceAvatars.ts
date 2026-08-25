import { groupParticipantStableKey } from './groupTitle';
import type { ConversationParticipant, ParticipantSpaceKind } from '@/kordi-app/types';

function clean(value?: string | null) {
  return value?.trim() ?? '';
}

function isSelf(participant: ConversationParticipant) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

export function participantSpaceAvatarParticipants(
  kind: ParticipantSpaceKind,
  participants: ConversationParticipant[],
  avatarAccountIds: string[] = [],
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
  const humans = participants.filter((participant) => participant.kind === 'human');
  const unkeyed: ConversationParticipant[] = [];
  const byAccountId = new Map(humans.flatMap((participant) => {
    const accountId = clean(participant.humanId) || clean(participant.sourceIdentityId);
    if (!accountId) unkeyed.push(participant);
    return accountId ? [[accountId, participant] as const] : [];
  }));
  const preferred = avatarAccountIds.flatMap((accountId) => {
    const participant = byAccountId.get(accountId);
    if (!participant) return [];
    byAccountId.delete(accountId);
    return [participant];
  });
  const remaining = [...byAccountId.values(), ...unkeyed].sort((left, right) => (
    groupParticipantStableKey(left).localeCompare(groupParticipantStableKey(right))
  ));
  return [...preferred, ...remaining].slice(0, 3);
}
