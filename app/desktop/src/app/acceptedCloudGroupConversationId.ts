/**
 * The chat list keys a Cloud group by its canonical session id
 * (`session:group:<uuid>`), which is also the server's `groupSpaceId`.
 * `group:<id>` is a sidebar space id, not a conversation id, so selecting it
 * matches no conversation and the shell falls back to another chat. Older
 * callers passed the prefixed form; strip it so both resolve to the session.
 */
export function acceptedCloudGroupConversationId(groupSpaceId: string | null | undefined): string {
  const trimmed = groupSpaceId?.trim() ?? '';
  return trimmed.startsWith('group:') ? trimmed.slice('group:'.length).trim() : trimmed;
}
