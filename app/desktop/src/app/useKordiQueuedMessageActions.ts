import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';

import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextareaForNativeInput,
} from '@/features/chat/composerController.shared';
import {
  updateScopeDraft,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import {
  removeQueuedDesktopMessageById,
  persistQueuedDesktopMessage,
  type QueuedDesktopMessagesBySession,
} from '@/features/chat/queuedDesktopMessages';

type UseKordiQueuedMessageActionsArgs = {
  isNativeShell: boolean;
  canonicalHumanIdentityId?: string | null;
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  onError: (message: string) => void;
  queuedMessagesBySession: QueuedDesktopMessagesBySession;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setQueuedMessagesBySession: Dispatch<
    SetStateAction<QueuedDesktopMessagesBySession>
  >;
};

export function useKordiQueuedMessageActions({
  isNativeShell,
  canonicalHumanIdentityId,
  setCanonicalSessionState,
  onError,
  queuedMessagesBySession,
  setComposerDrafts,
  setQueuedMessagesBySession,
}: UseKordiQueuedMessageActionsArgs) {
  const cancelQueuedMessage = useCallback(async (sessionId: string, queuedMessageId: string) => {
    const queuedMessage = (queuedMessagesBySession[sessionId] ?? []).find((message) => message.id === queuedMessageId);
    if (!queuedMessage) return false;
    setQueuedMessagesBySession((current) => removeQueuedDesktopMessageById(current, sessionId, queuedMessageId));
    try {
      const row = await persistQueuedDesktopMessage(queuedMessage, canonicalHumanIdentityId, 'cancelled');
      if (row) setCanonicalSessionState((current) => mergeCanonicalMessageRow(current, row));
      return true;
    } catch (error) {
      setQueuedMessagesBySession((current) => ({
        ...current, [sessionId]: [queuedMessage, ...(current[sessionId] ?? []).filter((message) => message.id !== queuedMessageId)],
      }));
      onError(error instanceof Error ? error.message : 'Unable to synchronize queued cancellation');
      return false;
    }
  }, [canonicalHumanIdentityId, onError, queuedMessagesBySession, setCanonicalSessionState, setQueuedMessagesBySession]);

  const editQueuedMessage = useCallback(
    async (sessionId: string, queuedMessageId: string) => {
      const queuedMessage = (queuedMessagesBySession[sessionId] ?? [])
        .find((message) => message.id === queuedMessageId);
      if (!queuedMessage) return;
      if (!await cancelQueuedMessage(sessionId, queuedMessageId)) return;

      setComposerDrafts((current) => updateScopeDraft(
        current,
        'chat',
        queuedMessage.sessionId,
        queuedMessage.text,
      ));
      focusComposerTextareaForNativeInput(
        CHAT_COMPOSER_TEXTAREA_SELECTOR,
        isNativeShell,
      );
    },
    [
      isNativeShell,
      cancelQueuedMessage,
      queuedMessagesBySession,
      setComposerDrafts,
    ],
  );

  return {
    cancelQueuedMessage,
    editQueuedMessage,
  };
}
