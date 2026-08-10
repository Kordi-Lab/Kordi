import { isLegacyCanonicalCollaborationSessionId, isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import type { ComposerScope } from '@/kordi-app/types';

import { isLocalDraftChatConversationId } from './draftSessions';

export function composerConfigTargetSessionId({
  scope,
  activeConversationUsesCollaboration,
  activeConvId,
  activeConvCanonicalSessionId,
  activeProjectSessionId,
  desktopActiveSessionId,
}: {
  scope: ComposerScope;
  activeConversationUsesCollaboration: boolean;
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  activeProjectSessionId: string;
  desktopActiveSessionId?: string | null;
}) {
  if (scope === 'project') return activeProjectSessionId;
  if (isLocalDraftChatConversationId(activeConvId)) return activeConvId;
  if (activeConversationUsesCollaboration) return null;

  const sessionId = activeConvCanonicalSessionId?.trim() || activeConvId.trim();
  if (!sessionId) return desktopActiveSessionId ?? null;
  if (activeConvId.startsWith('bridge:') || isLegacyCanonicalCollaborationSessionId(sessionId) || isCanonicalCloudSessionId(sessionId)) {
    return null;
  }
  return activeConvId;
}
