import type {
  ChatChannel,
  ParticipantSpaceSessionViewModel,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';

export function filterParticipantSpacesByChannel(
  spaces: ParticipantSpaceViewModel[],
  query: string,
  channel: ChatChannel,
  isVisibleAgentSession: (session: ParticipantSpaceSessionViewModel) => boolean,
) {
  const normalized = query.trim().toLowerCase();
  return spaces.flatMap((space) => {
    if (!spaceMatchesChannel(space, channel)) return [];
    const visibleSpace = channel === 'agent'
      ? visibleAgentSpace(space, isVisibleAgentSession)
      : space;
    if (channel === 'agent' && visibleSpace.kind !== 'self' && visibleSpace.sessions.length === 0) {
      return [];
    }
    if (!normalized) return [visibleSpace];
    const haystack = [
      visibleSpace.title,
      visibleSpace.preview,
      ...visibleSpace.participants.map((participant) => participant.name),
      ...visibleSpace.sessions.flatMap((session) => [session.title, session.preview]),
    ].join(' ').toLowerCase();
    return haystack.includes(normalized) ? [visibleSpace] : [];
  });
}

export function spaceMatchesChannel(
  space: ParticipantSpaceViewModel,
  channel: ChatChannel,
) {
  if (channel === 'agent') return space.kind === 'self' || space.kind === 'direct-agent';
  return space.kind === 'direct-human' || space.kind === 'group';
}

function visibleAgentSpace(
  space: ParticipantSpaceViewModel,
  isVisibleAgentSession: (session: ParticipantSpaceSessionViewModel) => boolean,
) {
  const sessions = space.sessions.filter(isVisibleAgentSession);
  const latest = sessions[0];
  return {
    ...space,
    sessions,
    sessionCount: sessions.length,
    unread: sessions.reduce((sum, session) => sum + session.unread, 0),
    updatedAtLabel: latest?.updatedAtLabel,
    updatedAtMs: latest?.updatedAtMs ?? 0,
    preview: latest?.preview ?? '',
  };
}
