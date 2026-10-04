import type { ConversationParticipant, ParticipantSpaceViewModel } from '@/kordi-app/types';
export const SELF_PARTICIPANT_SPACE_TITLE = 'Saved Messages';

export function ensureSelfParticipantSpace(
  spaces: ParticipantSpaceViewModel[],
  options: { avatarSeed?: string | null; profileImageUrl?: string | null } = {},
) {
  if (spaces.some((space) => space.kind === 'self')) return spaces;

  const avatarSeed = (options.avatarSeed?.trim() ?? '') || 'me';
  const selfParticipant: ConversationParticipant = {
    id: 'human:self',
    name: 'Me',
    kind: 'human',
    role: 'self',
    source: 'local',
    avatarKey: avatarSeed,
    profileImageUrl: (options.profileImageUrl?.trim() ?? '') || null,
  };

  const selfSpace: ParticipantSpaceViewModel = {
    id: 'self:local',
    kind: 'self',
    title: SELF_PARTICIPANT_SPACE_TITLE,
    participants: [selfParticipant],
    participantCount: 1,
    sessionCount: 0,
    unread: 0,
    updatedAtMs: 0,
    preview: '',
    avatarStack: [{ kind: 'human', seed: avatarSeed, isSelf: true, imageUrl: selfParticipant.profileImageUrl ?? null }],
    sessions: [],
  };

  return [...spaces, selfSpace];
}
