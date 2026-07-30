import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import { openOrCreateCanonicalSessionFast } from '@/lib/desktop';

import { mergeOpenCanonicalSessionResult } from './canonicalSessionStateMutations';
import type { ParticipantSpaceDraft } from './useKordiParticipantSpaceContinuation';
import { metadataString } from './useKordiAppModelHelpers';

type MutableValue<T> = {
  current: T;
};

type SendChatMessage = (
  draftOverride?: string,
  targetSessionId?: string,
  contextMessages?: DesktopChatContextMessage[],
) => Promise<void>;

type UseKordiParticipantDraftSendArgs = {
  activeConversationId: string;
  attachmentCount: number;
  canonicalState: CanonicalSessionState | null;
  currentDraft: string;
  draftByKeyRef: MutableValue<Map<string, ParticipantSpaceDraft>>;
  draftBySessionIdRef: MutableValue<Map<string, ParticipantSpaceDraft>>;
  materializeRef: MutableValue<Map<string, Promise<void>>>;
  sendMessage: SendChatMessage;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<ParticipantSpaceDraft[]>>;
};

export function useKordiParticipantDraftSend({
  activeConversationId,
  attachmentCount,
  canonicalState,
  currentDraft,
  draftByKeyRef,
  draftBySessionIdRef,
  materializeRef,
  sendMessage,
  setCanonicalState,
  setDesktopError,
  setDrafts,
}: UseKordiParticipantDraftSendArgs) {
  const materializeDraft = useCallback(async (sessionId: string) => {
    const draft = draftBySessionIdRef.current.get(sessionId);
    if (!draft) return;

    const pending = materializeRef.current.get(sessionId);
    if (pending) {
      await pending;
      return;
    }

    const materialize = (async () => {
      const localIdentityId =
        canonicalState?.profile.humanIdentityId?.trim();
      if (!canonicalState || !localIdentityId) {
        throw new Error('Local profile identity is not ready yet.');
      }
      const groupCreatorIdentityId =
        draft.conversation.canonicalCreatedByIdentityId?.trim()
        || metadataString(
          draft.conversation.metadata
          && typeof draft.conversation.metadata === 'object'
          && !Array.isArray(draft.conversation.metadata)
            ? draft.conversation.metadata as Record<string, unknown>
            : {},
          'groupCreatorIdentityId',
        )
        || localIdentityId;

      const existingSession = canonicalState.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existingSession) {
        const openResult = await openOrCreateCanonicalSessionFast({
          id: sessionId,
          kind: 'group',
          title: 'New session',
          status: 'active',
          createdByIdentityId: groupCreatorIdentityId,
          primaryIdentityId: null,
          relationshipIdentityId: null,
          participantIdentityIds: draft.participantIdentityIds,
          metadata: draft.conversation.metadata,
        });
        setCanonicalState(
          mergeOpenCanonicalSessionResult(canonicalState, openResult),
        );
      }

      draftBySessionIdRef.current.delete(sessionId);
      const currentByKey = draftByKeyRef.current.get(draft.createKey);
      if (currentByKey?.sessionId === sessionId) {
        draftByKeyRef.current.delete(draft.createKey);
      }
      setDrafts((current) => current.filter(
        (candidate) => candidate.sessionId !== sessionId,
      ));
    })();

    materializeRef.current.set(sessionId, materialize);
    try {
      await materialize;
    } finally {
      materializeRef.current.delete(sessionId);
    }
  }, [
    canonicalState,
    draftByKeyRef,
    draftBySessionIdRef,
    materializeRef,
    setCanonicalState,
    setDrafts,
  ]);

  return useCallback(async (
    draftOverride?: string,
    targetSessionId?: string,
    contextMessages?: DesktopChatContextMessage[],
  ) => {
    const hasSendableContent =
      (draftOverride ?? currentDraft).trim().length > 0
      || attachmentCount > 0;
    const candidateSessionId =
      targetSessionId || activeConversationId;
    if (
      hasSendableContent
      && draftBySessionIdRef.current.has(candidateSessionId)
    ) {
      try {
        await materializeDraft(candidateSessionId);
      } catch (error) {
        setDesktopError(
          error instanceof Error
            ? error.message
            : 'Unable to start group session',
        );
        return;
      }
    }
    await sendMessage(draftOverride, targetSessionId, contextMessages);
  }, [
    activeConversationId,
    attachmentCount,
    currentDraft,
    draftBySessionIdRef,
    materializeDraft,
    sendMessage,
    setDesktopError,
  ]);
}
