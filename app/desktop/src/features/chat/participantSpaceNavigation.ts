/** An explicit group-open action also reveals its channels in the chat sidebar. */
const EXPAND_PARTICIPANT_SPACE_EVENT = 'kordi-expand-participant-space';

export function requestParticipantSpaceExpansion(spaceId: string) {
  if (typeof window === 'undefined' || !spaceId.trim()) return;
  window.dispatchEvent(new window.CustomEvent(EXPAND_PARTICIPANT_SPACE_EVENT, { detail: spaceId }));
}

export function subscribeParticipantSpaceExpansion(expand: (spaceId: string) => void) {
  if (typeof window === 'undefined') return () => {};
  const onExpand = (event: Event) => {
    const spaceId: unknown = (event as CustomEvent).detail;
    if (typeof spaceId === 'string' && spaceId.trim()) expand(spaceId);
  };
  window.addEventListener(EXPAND_PARTICIPANT_SPACE_EVENT, onExpand);
  return () => window.removeEventListener(EXPAND_PARTICIPANT_SPACE_EVENT, onExpand);
}
