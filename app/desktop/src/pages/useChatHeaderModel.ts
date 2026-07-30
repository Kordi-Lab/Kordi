import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import {
  chatHeaderSubtitle,
  cloudSelfAgentSyncStatusLabel,
  selfAgentSessionIdForTitleRename,
} from '@/pages/chatsPage.header';
import type {
  ChatsPageLayout,
  ChatsPageSession,
} from '@/pages/chatsPage.types';

type UseChatHeaderModelInput = {
  isNativeShell: ChatsPageLayout['isNativeShell'];
  isSending: boolean;
  session: Pick<
    ChatsPageSession,
    | 'activeConv'
    | 'cloudSelfAgentSyncStatus'
    | 'isEditingDesktopSessionTitle'
    | 'setIsEditingDesktopSessionTitle'
    | 'desktopSessionRenameDraft'
    | 'setDesktopSessionRenameDraft'
    | 'onRenameDesktopSession'
    | 'onRenameChatSession'
  >;
};

export function useChatHeaderModel({
  isNativeShell,
  isSending,
  session,
}: UseChatHeaderModelInput) {
  const {
    activeConv,
    cloudSelfAgentSyncStatus,
    isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle,
    desktopSessionRenameDraft,
    setDesktopSessionRenameDraft,
    onRenameDesktopSession,
    onRenameChatSession,
  } = session;
  const selfAgentSessionId = selfAgentSessionIdForTitleRename(activeConv);
  const isDraft = activeConv.id === LOCAL_DRAFT_CHAT_CONVERSATION_ID
    || activeConv.canonicalSessionId === LOCAL_DRAFT_CHAT_CONVERSATION_ID;
  const isStarting = isDraft && isSending;
  const canRename = isNativeShell
    && activeConv.type === 'owned-agent'
    && (Boolean(selfAgentSessionId) || isDraft)
    && !isStarting;

  const commit = async () => {
    const baselineName = activeConv.name;
    const nextTitle = desktopSessionRenameDraft.trim();
    if (!canRename || !nextTitle) {
      setDesktopSessionRenameDraft(baselineName);
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    if (nextTitle === baselineName.trim()) {
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    if (selfAgentSessionId) {
      await onRenameChatSession(selfAgentSessionId, nextTitle);
      setDesktopSessionRenameDraft(nextTitle);
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    await onRenameDesktopSession(baselineName);
  };

  const begin = () => {
    if (!canRename) return;
    setDesktopSessionRenameDraft(activeConv.name);
    setIsEditingDesktopSessionTitle(true);
  };

  const cancel = () => {
    setDesktopSessionRenameDraft(activeConv.name);
    setIsEditingDesktopSessionTitle(false);
  };

  return {
    subtitle: chatHeaderSubtitle(activeConv),
    cloudSyncLabel: cloudSelfAgentSyncStatusLabel(cloudSelfAgentSyncStatus),
    isStarting,
    rename: {
      enabled: canRename,
      editing: isEditingDesktopSessionTitle,
      draft: desktopSessionRenameDraft,
      sessionId: selfAgentSessionId ?? activeConv.id,
      setDraft: setDesktopSessionRenameDraft,
      begin,
      cancel,
      commit,
    },
  };
}
