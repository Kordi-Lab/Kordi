import { useCallback, type Dispatch, type SetStateAction } from 'react';

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
  type QueuedDesktopMessagesBySession,
} from '@/features/chat/queuedDesktopMessages';

type UseKordiQueuedMessageActionsArgs = {
  isNativeShell: boolean;
  queuedMessagesBySession: QueuedDesktopMessagesBySession;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setQueuedMessagesBySession: Dispatch<
    SetStateAction<QueuedDesktopMessagesBySession>
  >;
};

export function useKordiQueuedMessageActions({
  isNativeShell,
  queuedMessagesBySession,
  setComposerDrafts,
  setQueuedMessagesBySession,
}: UseKordiQueuedMessageActionsArgs) {
  const editQueuedMessage = useCallback(
    (sessionId: string, queuedMessageId: string) => {
      const queuedMessage = (queuedMessagesBySession[sessionId] ?? [])
        .find((message) => message.id === queuedMessageId);
      if (!queuedMessage) return;

      setComposerDrafts((current) => updateScopeDraft(
        current,
        'chat',
        queuedMessage.sessionId,
        queuedMessage.text,
      ));
      setQueuedMessagesBySession((current) => (
        removeQueuedDesktopMessageById(
          current,
          sessionId,
          queuedMessageId,
        )
      ));
      focusComposerTextareaForNativeInput(
        CHAT_COMPOSER_TEXTAREA_SELECTOR,
        isNativeShell,
      );
    },
    [
      isNativeShell,
      queuedMessagesBySession,
      setComposerDrafts,
      setQueuedMessagesBySession,
    ],
  );

  const cancelQueuedMessage = useCallback(
    (sessionId: string, queuedMessageId: string) => {
      setQueuedMessagesBySession((current) => (
        removeQueuedDesktopMessageById(
          current,
          sessionId,
          queuedMessageId,
        )
      ));
    },
    [setQueuedMessagesBySession],
  );

  return {
    cancelQueuedMessage,
    editQueuedMessage,
  };
}
