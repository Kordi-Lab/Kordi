import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';

import {
  updateScopeDraft,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import type { DesktopChatState, DesktopChatTurnSnapshot, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { createDesktopChatSession, fetchDesktopChatState } from '@/lib/desktop';

type UseKordiSideAgentSessionActionsArgs = {
  desktopChatState: DesktopChatState | null;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot>;
  queuedDesktopMessagesBySession: Record<string, QueuedDesktopChatMessage[]>;
  mainConversationId: string | null;
  isNativeShell: boolean;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
};

function isReusableBlankDesktopSession(
  session: Pick<DesktopChatState['activeSession'], 'draft' | 'messageCount' | 'title'>,
) {
  const title = session.title.trim().toLowerCase();
  return session.messageCount === 0 && (
    session.draft
    || !title
    || [
      'new chat',
      'new session',
      'untitled session',
      'session',
      'kordi',
      'my kordi',
      'my agent',
      'my kordi session',
      'my agent session',
    ].includes(title)
  );
}

export function reusableBlankDesktopSessionId(
  state: DesktopChatState | null,
  excludedSessionId?: string | null,
  occupiedSessionIds: ReadonlySet<string> = new Set(),
) {
  if (!state) return null;
  const excludedId = excludedSessionId?.trim() ?? '';
  if (
    state.activeSession.id !== excludedId
    && !occupiedSessionIds.has(state.activeSession.id)
    && !state.activeSession.project
    && state.activeSession.messages.length === 0
    && isReusableBlankDesktopSession(state.activeSession)
  ) {
    return state.activeSession.id;
  }
  return state.sessions.find((session) => (
    session.id !== excludedId
    && !occupiedSessionIds.has(session.id)
    && isReusableBlankDesktopSession(session)
  ))?.id ?? null;
}

export function useKordiSideAgentSessionActions({
  desktopChatState,
  desktopLiveTurnsBySession,
  queuedDesktopMessagesBySession,
  mainConversationId,
  isNativeShell,
  setComposerDrafts,
  setDesktopChatError,
  setDesktopChatState,
}: UseKordiSideAgentSessionActionsArgs) {
  const createFlightRef = useRef<Promise<string | null> | null>(null);
  const setComposerTextForSession = useCallback(
    (sessionId: string, value: string) => {
      setComposerDrafts((current) => (
        updateScopeDraft(current, 'chat', sessionId, value)
      ));
    },
    [setComposerDrafts],
  );

  const createSideAgentSession = useCallback(() => {
    if (!isNativeShell) return Promise.resolve(null);
    if (createFlightRef.current) return createFlightRef.current;
    const request = (async () => {
      try {
        setDesktopChatError(null);
        const occupiedSessionIds = new Set([
          ...Object.keys(desktopLiveTurnsBySession),
          ...Object.entries(queuedDesktopMessagesBySession)
            .filter(([, messages]) => messages.length > 0)
            .map(([sessionId]) => sessionId),
        ]);
        const reusableSessionId = reusableBlankDesktopSessionId(
          desktopChatState,
          mainConversationId,
          occupiedSessionIds,
        );
        const nextState = reusableSessionId
          ? desktopChatState?.activeSessionId === reusableSessionId
            ? desktopChatState
            : await fetchDesktopChatState(reusableSessionId)
          : await createDesktopChatSession();
        if (!nextState) throw new Error('Unable to load the empty agent session');
        const sessionId = nextState.activeSessionId?.trim() || null;
        setDesktopChatState(nextState);
        if (sessionId) {
          setComposerDrafts((current) => (
            updateScopeDraft(current, 'chat', sessionId, '')
          ));
        }
        return sessionId;
      } catch (error) {
        setDesktopChatError(
          error instanceof Error
            ? error.message
            : 'Unable to create agent session',
        );
        return null;
      }
    })().finally(() => {
      createFlightRef.current = null;
    });
    createFlightRef.current = request;
    return request;
  }, [
    desktopChatState,
    desktopLiveTurnsBySession,
    isNativeShell,
    mainConversationId,
    queuedDesktopMessagesBySession,
    setComposerDrafts,
    setDesktopChatError,
    setDesktopChatState,
  ]);

  return {
    createSideAgentSession,
    setComposerTextForSession,
  };
}
