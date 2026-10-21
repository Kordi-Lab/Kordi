import { isChatNavigation } from '@/features/chat/chatNavigation';
import { isEmptyChatSelectionId } from '@/features/chat/draftSessions';
import { Brain, CheckCircle2, FolderOpen, Info, Layers3 } from 'lucide-react';

import { ChatDetailPanel } from '@/pages/ChatDetailPanel';
import { CloudChatPersonInfo } from '@/features/cloud/CloudChatPersonInfo';
import { cloudDirectChatPeerAccountId } from '@/features/cloud/cloudDirectChatPeer';
import { DocumentReaderHostContext, documentReaderHostForConversation } from '@/features/documents/documentReaderHost';
import { ProjectDetailPanel } from '@/pages/ProjectDetailPanel';
import { RightDetailRail } from '@/pages/RightDetailRail';
import { navigateToTranscriptMessageOrScrollBottom } from '@/features/chat/transcriptNavigation';

import type { RightDetailShellArgs } from '@/app/kordiShellSlots.types';
import type { DetailTab } from '@/kordi-app/types';

export function assembleRightDetailSlot(args: RightDetailShellArgs) {
  const activeChatSessionId = args.activeConv.canonicalSessionId ?? args.activeConv.id;
  const activeProjectSessionId = args.activeProjectSession.id;
  const navigateToResponse = (messageId: string) => {
    const navigate = () => navigateToTranscriptMessageOrScrollBottom(messageId, args.chatTranscriptScrollRef);
    if (!isChatNavigation(args.activeNav)) {
      navigate();
      return;
    }
    args.setIsDetailPanelCollapsed(true);
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      navigate();
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(navigate));
  };
  const allDetailTabs: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = isChatNavigation(args.activeNav)
    ? [
        { id: 'info', label: 'Info', icon: Info },
        { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
        { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
        { id: 'memory', label: 'Memory', icon: Brain },
      ]
    : [
        { id: 'info', label: 'Info', icon: Info },
        { id: 'context', label: 'Context', icon: Layers3 },
        { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
        { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
        { id: 'memory', label: 'Memory', icon: Brain },
      ];
  const detailTabs = allDetailTabs;
  const account = args.cloudSession?.account ?? null;
  const personPeerAccountId = account && args.activeConversationUsesCollaboration && isChatNavigation(args.activeNav)
    ? cloudDirectChatPeerAccountId(args.activeConv, account.accountId)
    : null;
  const renderPersonInfo = account && personPeerAccountId
    ? (legacy: React.ReactNode) => (
        <CloudChatPersonInfo
          account={account}
          conversation={args.activeConv}
          peerAccountId={personPeerAccountId}
          muted={activeChatSessionId ? args.mutedChatSessionIds.has(activeChatSessionId) : null}
          onSetMuted={(muted) => args.handleSetChatSessionMuted(activeChatSessionId, muted)}
          onReturnToChat={() => args.setIsDetailPanelCollapsed(true)}
          legacy={legacy}
        />
      )
    : undefined;

  return (
    <RightDetailRail
      detailTabs={detailTabs}
      activeDetailTab={args.activeDetailTab}
      onSelectDetailTab={(tab) => {
        args.setActiveDetailTab(tab);
        args.setActiveSourcePreview(null);
      }}
      activeSourcePreview={args.activeSourcePreview}
      onCloseSourcePreview={() => args.setActiveSourcePreview(null)}
      variant={isChatNavigation(args.activeNav) ? 'page' : 'rail'}
    >
      {args.activeNav === 'projects' ? (
        <ProjectDetailPanel
          isNativeShell={args.isNativeShell}
          activeDetailTab={args.activeDetailTab}
          activeProject={args.activeProject}
          activeProjectSession={args.activeProjectSession}
          activeProjectLastMessage={args.activeProjectLastMessage}
          activeLiveTurn={args.desktopLiveTurn?.sessionId === activeProjectSessionId ? args.desktopLiveTurn : null}
          onSetTasksTab={() => args.setActiveDetailTab('tasks')}
          getStatusBadgeClass={args.getStatusBadgeClass}
          artifacts={args.activeProjectArtifacts}
          activeArtifactId={args.activeArtifactId}
          onSelectArtifact={args.setActiveArtifactId}
          onOpenArtifact={(artifactId) => {
            args.setActiveArtifactId(artifactId);
            args.setActiveDetailTab('artifacts');
          }}
          onNavigateToResponse={navigateToResponse}
        />
      ) : (
        <DocumentReaderHostContext.Provider value={{ opensDocumentsInCompanion: true, ...documentReaderHostForConversation({
          account: args.cloudSession?.account ?? null,
          conversation: args.activeConv,
          contacts: args.displayedContacts ?? [],
          isNativeShell: args.isNativeShell,
          startChatWithPerson: args.handleStartChatWithPerson,
          forwardMessage: args.onForwardMessage,
          // Cloud chats take a document the way the composer sends one: an attachment-only message.
          sendAttachmentMessage: args.activeConversationUsesCollaboration && !isEmptyChatSelectionId(args.activeConv.id)
            ? (attachment) => args.handleSendChatMessage('', undefined, undefined, [attachment])
            : undefined,
        }) }}>
        <ChatDetailPanel
          isNativeShell={args.isNativeShell}
          activeDetailTab={args.activeDetailTab}
          activeConv={args.activeConv}
          activeConvHasSubtitle={args.activeConvHasSubtitle}
          activeLastMessage={args.activeLastMessage}
          activeLiveTurn={args.desktopLiveTurn?.sessionId === activeChatSessionId ? args.desktopLiveTurn : null}
          activeConversationUsesCollaboration={args.activeConversationUsesCollaboration}
          activeCollaborationConversationHostNodeId={args.activeCollaborationConversationHost?.nodeId}
          activeCollaborationConversationHostUrl={args.activeCollaborationConversationHost?.serverUrl}
          activeCollaborationConversation={args.activeCollaborationConversation}
          activeCollaborationAwaitingReply={args.activeCollaborationAwaitingReply}
          isCollaborationSyncing={args.isCollaborationSyncing}
          lastCollaborationSyncAtLabel={args.lastCollaborationSyncAtLabel}
          activeSessionProject={!args.activeConversationUsesCollaboration ? args.activeSessionProject : null}
          artifacts={args.activeChatArtifacts}
          activeArtifactId={args.activeArtifactId}
          onSelectArtifact={args.setActiveArtifactId}
          onOpenArtifact={(artifactId) => {
            args.setActiveArtifactId(artifactId);
            args.setActiveDetailTab('artifacts');
          }}
          onNavigateToResponse={navigateToResponse}
          onOpenOutreachThread={(conversationId) => {
            args.setActiveNav('chats');
            args.setActiveConvId(conversationId);
          }}
          renderPersonInfo={renderPersonInfo}
        />
        </DocumentReaderHostContext.Provider>
      )}
    </RightDetailRail>
  );
}
