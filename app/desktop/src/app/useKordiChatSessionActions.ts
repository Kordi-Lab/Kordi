import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import {
  buildChatGroupCollaborationUpdateParticipants,
  buildChatGroupCollaborationUpdateTargets,
} from '@/features/chat/chatCreateFlows';
import type { ComposerDraftState } from '@/features/chat/composerDrafts';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import type {
  CanonicalSessionState,
  DesktopChatState,
} from '@/kordi-app/types';
import {
  appendCanonicalMessage,
  archiveDesktopChatSession,
  renameCanonicalSession,
  renameDesktopChatSession,
} from '@/lib/desktop';

import {
  activeGroupAdminIds,
  canonicalGroupParticipantsForSession,
  canonicalIdentityDisplayName,
  metadataGroupSpaceId,
  removeSessionFromCanonicalState,
  removeSessionFromDesktopState,
  sessionMetadataRecord,
  sessionRenameNoticeText,
  shouldUseCloudSessionAction,
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

type UseKordiChatSessionActionsArgs = {
  account: CloudAccount | null;
  activeConversationId: string;
  canonicalState: CanonicalSessionState | null;
  desktopState: DesktopChatState | null;
  isNativeShell: boolean;
  deleteCloudSession: (sessionId: string) => Promise<void>;
  hideCloudSession: (sessionId: string) => Promise<void>;
  refreshCanonicalState: () => Promise<void>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<void>;
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDesktopState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setLocallyHiddenSessionIds: Dispatch<SetStateAction<Set<string>>>;
};

export function useKordiChatSessionActions({
  account,
  activeConversationId,
  canonicalState,
  desktopState,
  isNativeShell,
  deleteCloudSession,
  hideCloudSession,
  refreshCanonicalState,
  refreshDesktopChat,
  sendCloudGroupControl,
  setActiveConversationId,
  setCanonicalState,
  setComposerDrafts,
  setDesktopError,
  setDesktopState,
  setLocallyHiddenSessionIds,
}: UseKordiChatSessionActionsArgs) {
  const desktopActiveSessionId = desktopState?.activeSessionId;
  const desktopSessions = desktopState?.sessions;

  const optimisticallyRemoveSession = useCallback((sessionId: string) => {
    const fallbackSessionId = desktopSessions?.find(
      (session) => session.id !== sessionId,
    )?.id ?? LOCAL_DRAFT_CHAT_CONVERSATION_ID;
    setLocallyHiddenSessionIds((current) => new Set(current).add(sessionId));
    setDesktopState((current) => removeSessionFromDesktopState(
      current,
      sessionId,
    ));
    setCanonicalState((current) => removeSessionFromCanonicalState(
      current,
      sessionId,
    ));
    setComposerDrafts((current) => updateScopeDraft(
      current,
      'chat',
      sessionId,
      '',
    ));
    if (
      activeConversationId === sessionId
      || desktopActiveSessionId === sessionId
    ) {
      setActiveConversationId(fallbackSessionId);
    }
  }, [
    activeConversationId,
    desktopActiveSessionId,
    desktopSessions,
    setActiveConversationId,
    setCanonicalState,
    setComposerDrafts,
    setDesktopState,
    setLocallyHiddenSessionIds,
  ]);

  const syncGroupSessionTitleRename = useCallback(async (
    state: CanonicalSessionState,
    sessionId: string,
    title: string,
    actorIdentityId: string,
  ) => {
    const participants = canonicalGroupParticipantsForSession(
      state,
      sessionId,
    );
    const targets = buildChatGroupCollaborationUpdateTargets({
      actorIdentityId,
      participants,
    });
    if (targets.length === 0) return;
    const updateParticipants =
      buildChatGroupCollaborationUpdateParticipants({
        participants,
        adminIdentityIds: activeGroupAdminIds(state, sessionId),
      });
    const currentMetadata = sessionMetadataRecord(state, sessionId);
    const parentGroupSpaceId =
      metadataGroupSpaceId(currentMetadata) || sessionId;
    const cloudTargetAccountIds = cloudGroupTargetAccountIds(targets);
    if (cloudTargetAccountIds.length > 0 && account) {
      await sendCloudGroupControl({
        targetAccountIds: cloudTargetAccountIds,
        kind: 'session-title-update',
        groupId: sessionId,
        groupSpaceId: parentGroupSpaceId,
        groupTitle: title,
        participants: cloudGroupParticipantsForCollaborationSession(
          account,
          updateParticipants,
        ),
      });
    }
  }, [account, sendCloudGroupControl]);

  const renameSession = useCallback(async (
    sessionId: string,
    title: string,
  ) => {
    if (!isNativeShell || !sessionId.trim()) return;
    const nextTitle = title.trim();
    if (!nextTitle) return;
    const actorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim() || undefined;
    const isDesktopRuntimeSession = desktopSessions?.some(
      (session) => session.id === sessionId,
    ) ?? false;
    try {
      setDesktopError(null);
      let nextCanonical = await renameCanonicalSession({
        sessionId,
        title: nextTitle,
        requestedByIdentityId: actorIdentityId,
      });
      const renamedSession = nextCanonical.sessions.find(
        (session) => session.id === sessionId,
      );
      if (actorIdentityId && renamedSession?.kind === 'group') {
        nextCanonical = await appendCanonicalRenameNotice(
          nextCanonical,
          sessionId,
          nextTitle,
          'session',
          actorIdentityId,
        );
      }
      setCanonicalState(nextCanonical);
      if (isDesktopRuntimeSession) {
        setDesktopState(
          await renameDesktopChatSession(sessionId, nextTitle),
        );
      } else {
        await refreshDesktopChat();
      }
      if (actorIdentityId && renamedSession?.kind === 'group') {
        try {
          await syncGroupSessionTitleRename(
            nextCanonical,
            sessionId,
            nextTitle,
            actorIdentityId,
          );
        } catch (error) {
          setDesktopError(
            `Session renamed, but hosted sync failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      await refreshCanonicalState();
      setDesktopError(
        error instanceof Error ? error.message : 'Unable to rename session',
      );
    }
  }, [
    canonicalState?.profile.humanIdentityId,
    desktopSessions,
    isNativeShell,
    refreshCanonicalState,
    refreshDesktopChat,
    setCanonicalState,
    setDesktopError,
    setDesktopState,
    syncGroupSessionTitleRename,
  ]);

  const archiveSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!isNativeShell || !trimmedSessionId) return;

    try {
      setDesktopError(null);
      if (shouldUseCloudSessionAction(trimmedSessionId)) {
        await hideCloudSession(trimmedSessionId);
        optimisticallyRemoveSession(trimmedSessionId);
        await refreshCanonicalState();
        return;
      }

      optimisticallyRemoveSession(trimmedSessionId);
      const nextState = await archiveDesktopChatSession(
        trimmedSessionId,
        desktopActiveSessionId,
      );
      setDesktopState(nextState);
      if (
        activeConversationId === trimmedSessionId
        || desktopActiveSessionId === trimmedSessionId
      ) {
        setActiveConversationId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message =
        error instanceof Error ? error.message : 'Unable to hide session';
      setDesktopError(message.startsWith('Session not found') ? null : message);
      if (shouldUseCloudSessionAction(trimmedSessionId)) throw error;
    }
  }, [
    activeConversationId,
    desktopActiveSessionId,
    hideCloudSession,
    isNativeShell,
    optimisticallyRemoveSession,
    refreshCanonicalState,
    setActiveConversationId,
    setDesktopError,
    setDesktopState,
  ]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!isNativeShell || !trimmedSessionId) return;

    try {
      setDesktopError(null);
      if (shouldUseCloudSessionAction(trimmedSessionId)) {
        await deleteCloudSession(trimmedSessionId);
        optimisticallyRemoveSession(trimmedSessionId);
        try {
          const nextState = await archiveDesktopChatSession(
            trimmedSessionId,
            desktopActiveSessionId,
          );
          setDesktopState(nextState);
          if (
            activeConversationId === trimmedSessionId
            || desktopActiveSessionId === trimmedSessionId
          ) {
            setActiveConversationId(nextState.activeSessionId);
          }
        } catch (localError) {
          const localMessage = localError instanceof Error
            ? localError.message
            : String(localError);
          if (!localMessage.startsWith('Session not found')) throw localError;
        }
        await refreshCanonicalState();
        return;
      }

      optimisticallyRemoveSession(trimmedSessionId);
      const nextState = await archiveDesktopChatSession(
        trimmedSessionId,
        desktopActiveSessionId,
      );
      setDesktopState(nextState);
      if (
        activeConversationId === trimmedSessionId
        || desktopActiveSessionId === trimmedSessionId
      ) {
        setActiveConversationId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message =
        error instanceof Error ? error.message : 'Unable to remove chat';
      setDesktopError(message.startsWith('Session not found') ? null : message);
      if (shouldUseCloudSessionAction(trimmedSessionId)) throw error;
    }
  }, [
    activeConversationId,
    deleteCloudSession,
    desktopActiveSessionId,
    isNativeShell,
    optimisticallyRemoveSession,
    refreshCanonicalState,
    setActiveConversationId,
    setDesktopError,
    setDesktopState,
  ]);

  return {
    renameSession,
    archiveSession,
    deleteSession,
  };
}
