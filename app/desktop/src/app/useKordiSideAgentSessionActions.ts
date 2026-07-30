import { useCallback, type Dispatch, type SetStateAction } from 'react';

import {
  updateScopeDraft,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import type { DesktopChatState } from '@/kordi-app/types';
import { createDesktopChatSession } from '@/lib/desktop';

type UseKordiSideAgentSessionActionsArgs = {
  activeDesktopSessionId: string | null;
  isNativeShell: boolean;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
};

export function useKordiSideAgentSessionActions({
  activeDesktopSessionId,
  isNativeShell,
  setComposerDrafts,
  setDesktopChatError,
  setDesktopChatState,
}: UseKordiSideAgentSessionActionsArgs) {
  const setComposerTextForSession = useCallback(
    (sessionId: string, value: string) => {
      setComposerDrafts((current) => (
        updateScopeDraft(current, 'chat', sessionId, value)
      ));
    },
    [setComposerDrafts],
  );

  const createSideAgentSession = useCallback(async () => {
    if (!isNativeShell) return null;
    try {
      setDesktopChatError(null);
      const nextState = await createDesktopChatSession();
      const sessionId = nextState.activeSessionId?.trim() || null;
      setDesktopChatState(
        activeDesktopSessionId
          ? { ...nextState, activeSessionId: activeDesktopSessionId }
          : nextState,
      );
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
  }, [
    activeDesktopSessionId,
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
