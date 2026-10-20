import type { AppendCanonicalMessageRequest, CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import { upsertCanonicalMessageFast } from '@/lib/desktop';

/**
 * Links a published Ask Agent request to its Cloud id before the Mac's native
 * turn starts. The turn's user entry carries that id, so the native transcript
 * sync then joins the request instead of storing a second user message (and
 * hiding the request's processing reply until it is reconciled).
 */
export async function linkPublishedSelfAgentRequest(
  state: CanonicalSessionState | null,
  localMessageId: string,
  cloudMessageId: string,
  persist: (request: AppendCanonicalMessageRequest) => Promise<unknown> = upsertCanonicalMessageFast,
): Promise<CanonicalSessionMessage | null> {
  const row = state?.messages.find((message) => message.id === localMessageId);
  if (!row || row.senderRole !== 'user') return null;
  const content = row.content && typeof row.content === 'object' && !Array.isArray(row.content)
    ? row.content as Record<string, unknown> : {};
  if (content.desktopEntryId === cloudMessageId) return null;
  const linked = { ...row, content: { ...content, desktopEntryId: cloudMessageId } };
  await persist({
    id: linked.id, sessionId: linked.sessionId, senderIdentityId: linked.senderIdentityId,
    senderRole: linked.senderRole, messageKind: linked.messageKind, contentText: linked.contentText,
    content: linked.content, parentMessageId: linked.parentMessageId ?? null,
    delegatedExchangeId: linked.delegatedExchangeId ?? null, status: linked.status,
    createdAtMs: linked.createdAtMs, sourceTransport: linked.sourceTransport ?? null,
    sourceEventId: linked.sourceEventId ?? null,
  });
  return linked;
}
