import { isLocalDraftChatConversationId } from '../draftSessions';
import { localChatTargetHasRunningTurn } from './localChatQueue';

export function activeLocalTurnShouldDelayChatSend({
  activeConversationUsesCollaborationRouting,
  activeConvId,
  desktopLiveTurn,
}: {
  activeConversationUsesCollaborationRouting: boolean;
  activeConvId: string;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
}) {
  return !activeConversationUsesCollaborationRouting
    && !activeConvId.startsWith('bridge:')
    && !isLocalDraftChatConversationId(activeConvId)
    && localChatTargetHasRunningTurn(desktopLiveTurn, activeConvId);
}
export function localChatTargetSessionIdForActiveConversation({
  activeConvId,
  activeConvCanonicalSessionId,
  desktopActiveSessionId,
}: {
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  desktopActiveSessionId?: string | null;
}) {
  const activeSessionId = activeConvId.trim();
  if (isLocalDraftChatConversationId(activeSessionId)) return null;

  const canonicalSessionId = activeConvCanonicalSessionId?.trim() ?? '';
  if (canonicalSessionId && !isLocalDraftChatConversationId(canonicalSessionId)) {
    return canonicalSessionId;
  }

  if (activeSessionId && !activeSessionId.startsWith('bridge:')) {
    return activeSessionId;
  }

  const desktopSessionId = desktopActiveSessionId?.trim() ?? '';
  if (desktopSessionId && !isLocalDraftChatConversationId(desktopSessionId)) {
    return desktopSessionId;
  }

  return null;
}

export function chatDraftSessionIdsToClearForSend(activeSessionId: string, resolvedSessionId: string) {
  return [activeSessionId, resolvedSessionId]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId, index, sessionIds) => Boolean(sessionId) && sessionIds.indexOf(sessionId) === index);
}
