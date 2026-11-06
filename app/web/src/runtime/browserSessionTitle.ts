import type { CanonicalSession, OpenCanonicalSessionRequest } from '@/kordi-app/types';
import { incomingSessionTitleWins, titleSourceFromMetadata } from '@/features/chat/sessionTitlePolicy';

const TITLE_KEYS = ['titleSource', 'sessionTitleSource', 'sessionTitleRevision', 'sessionTitlePolicyVersion',
  'sessionTitleUpdatedAtMs', 'sessionTitleUpdatedByAccountId', 'sessionTitleGeneratedFromMessageId'];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The same title precedence used by native/cloud sync prevents replayed
 * placeholder or automatic titles from replacing a confirmed manual rename. */
export function browserSessionTitle(previous: CanonicalSession | undefined, request: OpenCanonicalSessionRequest, now: number) {
  const title = request.title?.trim() || previous?.title || 'New chat';
  const next = { ...record(previous?.metadata), ...record(request.metadata) };
  if (!previous) return { title, metadata: request.metadata };
  const before = record(previous.metadata);
  const incoming = record(request.metadata);
  const descriptor = (metadata: Record<string, unknown>, value: string, updatedAtMs: number) => ({
    titleSource: titleSourceFromMetadata(metadata, value),
    titleRevision: Number(metadata.sessionTitleRevision) || 0,
    updatedAtMs: Number(metadata.sessionTitleUpdatedAtMs) || updatedAtMs,
    updatedByAccountId: typeof metadata.sessionTitleUpdatedByAccountId === 'string' ? metadata.sessionTitleUpdatedByAccountId : null,
  });
  if (!request.title || !incomingSessionTitleWins(descriptor(before, previous.title, previous.updatedAtMs), descriptor(incoming, title, now))) {
    for (const key of TITLE_KEYS) {
      delete next[key];
      if (key in before) next[key] = before[key];
    }
    return { title: previous.title, metadata: next };
  }
  return { title, metadata: next };
}
