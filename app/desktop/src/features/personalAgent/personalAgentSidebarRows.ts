import type { Conversation } from '@/kordi-app/types';
import { personalAgentEntryForConversation } from './personalAgentEntries';
import type { PersonalAgentEntry } from './personalAgentStore';

type SessionRow = {
  session: { id: string; canonicalSessionId?: string | null; preview?: string; conversation: Conversation };
};

/**
 * The personal sessions the chat list leaves out: those with no messages
 * yet. A personal agent shows as the Personal agent entry, never as an empty
 * chat; once it or its owner has written, its session is an ordinary chat in
 * the list. Sessions this Mac does not have yet are left out too.
 */
export function emptyPersonalAgentSessionIds(
  entries: readonly PersonalAgentEntry[],
  sessionRows: ReadonlyMap<string, SessionRow>,
  /** No list has loaded yet: a session's own marker also counts. */
  { markerFallback = false }: { markerFallback?: boolean } = {},
) {
  const withMessages = new Set<string>();
  const empty = new Set<string>();
  for (const [sessionId, row] of sessionRows) {
    const { conversation } = row.session;
    const entry = personalAgentEntryForConversation(entries, {
      ...conversation, id: conversation.id || row.session.id,
      canonicalSessionId: row.session.canonicalSessionId ?? conversation.canonicalSessionId,
    }, { markerFallback });
    if (!entry) continue;
    // A transcript that is not loaded yet still has its count and preview.
    const written = conversation.messages.length > 0 || (conversation.canonicalMessageCount ?? 0) > 0 || Boolean(row.session.preview?.trim());
    if (written) withMessages.add(entry.agentId);
    else empty.add(sessionId);
  }
  for (const entry of entries) {
    if (withMessages.has(entry.agentId)) continue;
    for (const id of [entry.sessionId, entry.conversationId]) if (id) empty.add(id);
  }
  return empty;
}
