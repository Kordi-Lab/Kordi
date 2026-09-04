import type { CanonicalSessionState } from '@/kordi-app/types';
import { appendCanonicalMessage } from '@/lib/desktop';

import {
  canonicalIdentityDisplayName,
  sessionRenameNoticeText,
} from './useKordiAppModelHelpers';

export async function appendCanonicalRenameNotice(
  state: CanonicalSessionState,
  sessionId: string,
  title: string,
  scope: 'group' | 'session',
  actorIdentityId: string,
) {
  const actorName = canonicalIdentityDisplayName(state, actorIdentityId);
  const now = Date.now();
  return appendCanonicalMessage({
    sessionId,
    senderIdentityId: actorIdentityId,
    senderRole: 'system',
    messageKind: 'status',
    contentText: sessionRenameNoticeText(actorName, title, scope),
    content: {
      kind: 'session-title-update',
      scope,
      title,
      actorDisplayName: actorName,
    },
    createdAtMs: now,
    status: 'complete',
    sourceTransport: 'desktop-local-session-update',
    sourceEventId:
      `desktop-local-session-update:${sessionId}:${scope}:${now}`,
  });
}
