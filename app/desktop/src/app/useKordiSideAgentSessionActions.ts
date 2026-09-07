import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';

import {
  updateScopeDraft,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { loadSession } from '@/features/cloud/session';
import type { DesktopChatState } from '@/kordi-app/types';
import { createDesktopChatSession } from '@/lib/desktop';

type UseKordiSideAgentSessionActionsArgs = {
  isNativeShell: boolean;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
};

export function useKordiSideAgentSessionActions({
  isNativeShell,
  setComposerDrafts,
  setDesktopChatError,
  setDesktopChatState,
}: UseKordiSideAgentSessionActionsArgs) {
  const createFlightRef = useRef<{ source?: string; promise: Promise<string | null> } | null>(null);
  const setComposerTextForSession = useCallback(
    (sessionId: string, value: string) => {
      setComposerDrafts((current) => (
        updateScopeDraft(current, 'chat', sessionId, value)
      ));
    },
    [setComposerDrafts],
  );

  const createSideAgentSession = useCallback((sourceSessionId?: string) => {
    if (!isNativeShell) return Promise.resolve(null);
    if (createFlightRef.current?.source === sourceSessionId && createFlightRef.current) return createFlightRef.current.promise;
    const request = (async () => {
      try {
        setDesktopChatError(null);
        const account = await loadSession();
        const nextState = await createDesktopChatSession({ independent: true, sourceSessionId });
        if ((await loadSession())?.accountId !== account?.accountId) return null;
        if (!nextState) throw new Error('Unable to load the empty agent session');
        const sessionId = nextState.activeSessionId?.trim() || null;
        if (!sessionId || isLocalDraftChatConversationId(sessionId) || sessionId === sourceSessionId
          || nextState.activeSession.id !== sessionId || nextState.activeSession.messageCount > 0
          || nextState.activeSession.messages.length > 0) throw new Error('Unable to create an empty private Agent session.');
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
      if (createFlightRef.current?.promise === request) createFlightRef.current = null;
    });
    createFlightRef.current = { source: sourceSessionId, promise: request };
    return request;
  }, [
    isNativeShell,
    setComposerDrafts,
    setDesktopChatError,
    setDesktopChatState,
  ]);

  return {
    createSideAgentSession,
    setComposerTextForSession,
  };
}
