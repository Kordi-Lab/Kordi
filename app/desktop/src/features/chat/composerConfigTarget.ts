import { isLegacyCanonicalCollaborationSessionId, isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from './draftSessions';
import type { ComposerScope, DesktopChatState } from '@/kordi-app/types';

export function desktopChatStateAfterConfigUpdate(
  current: DesktopChatState | null,
  next: DesktopChatState,
  isolated: boolean,
): DesktopChatState | null {
  if (isolated || !current || current.activeSessionId !== next.activeSessionId
    || current.activeSession.id !== next.activeSession.id) return current;
  // A config response is a snapshot taken independently of sends and history
  // refreshes. Apply its settings without replacing the current transcript.
  const { provider, providerLabel, model, modelLabel, thinking, thinkingLabel, thinkingLevels } = next.activeSession;
  return {
    ...current,
    activeSession: {
      ...current.activeSession,
      provider, providerLabel, model, modelLabel, thinking, thinkingLabel, thinkingLevels,
    },
  };
}

export function composerConfigTargetSessionId({
  scope,
  activeConversationUsesCollaboration = false,
  activeConvId,
  activeConvCanonicalSessionId,
  activeProjectSessionId,
  desktopActiveSessionId,
}: {
  scope: ComposerScope;
  activeConversationUsesCollaboration?: boolean;
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  activeProjectSessionId: string;
  desktopActiveSessionId?: string | null;
}) {
  if (scope === 'project') return activeProjectSessionId;
  if (activeConversationUsesCollaboration) return null;
  if (isLocalDraftChatConversationId(activeConvId)) return activeConvId;

  const sessionId = activeConvCanonicalSessionId?.trim() || activeConvId.trim();
  if (!sessionId) return desktopActiveSessionId ?? null;
  if (activeConvId.startsWith('bridge:') || isLegacyCanonicalCollaborationSessionId(sessionId) || isCanonicalCloudSessionId(sessionId)) {
    return null;
  }
  return sessionId;
}
