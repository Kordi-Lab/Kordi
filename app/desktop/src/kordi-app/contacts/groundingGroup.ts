import type { ParticipantSpaceViewModel } from '../types';

/** Whether the server marked any of the group's chats as started from a Grounding room. */
export function isGroundingGroupSpace(space: ParticipantSpaceViewModel) {
  return space.sessions.some((session) => {
    const metadata = session.conversation?.metadata;
    return Boolean(metadata) && typeof metadata === 'object'
      && (metadata as Record<string, unknown>).groupOrigin === 'grounding';
  });
}
