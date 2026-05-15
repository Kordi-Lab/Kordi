import { CheckCircle2, FolderOpen, Info, Layers3 } from 'lucide-react';

import { ChatDetailPanel } from '@/pages/ChatDetailPanel';
import { ProjectDetailPanel } from '@/pages/ProjectDetailPanel';
import { RightDetailRail } from '@/pages/RightDetailRail';
import { navigateToTranscriptMessageOrScrollBottom } from '@/kordi-app/components/transcriptReplyAttribution';

import type { RightDetailShellArgs } from '@/app/kordiShellSlots.types';
import type { DetailTab } from '@/kordi-app/types';

export function assembleRightDetailSlot(args: RightDetailShellArgs) {
  const activeChatSessionId = args.activeConv.canonicalSessionId ?? args.activeConv.id;
  const activeProjectSessionId = args.activeProjectSession.id;
  const navigateToResponse = (messageId: string) => {
    navigateToTranscriptMessageOrScrollBottom(messageId, args.chatTranscriptScrollRef);
  };
  const allDetailTabs: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = args.activeNav === 'chats'
    ? [
        { id: 'info', label: 'Info', icon: Info },
        { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
        { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
      ]
    : [
        { id: 'info', label: 'Info', icon: Info },
        { id: 'context', label: 'Context', icon: Layers3 },
        { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
        { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
      ];
  const detailTabs = allDetailTabs;

  return (
    <RightDetailRail
      detailTabs={detailTabs.map((tab) => ({ id: tab.id, label: tab.label }))}
      activeDetailTab={args.activeDetailTab}
      onSelectDetailTab={(tab) => {
        args.setActiveDetailTab(tab);
        args.setActiveSourcePreview(null);
      }}
      activeSourcePreview={args.activeSourcePreview}
      onCloseSourcePreview={() => args.setActiveSourcePreview(null)}
    >
      {args.activeNav === 'projects' ? (
        <ProjectDetailPanel
          isNativeShell={args.isNativeShell}
          activeDetailTab={args.activeDetailTab}
          activeProject={args.activeProject}
          activeProjectSession={args.activeProjectSession}
          activeProjectLastMessage={args.activeProjectLastMessage}
          activeLiveTurn={args.desktopLiveTurn?.sessionId === activeProjectSessionId ? args.desktopLiveTurn : null}
          activeProjectBridgeHost={args.activeProjectBridgeHost}
          activeProjectBridgeProject={args.activeProjectBridgeProject}
          isProjectBridgeBusy={args.isProjectBridgeBusy}
          bridgeInvite={args.bridgeInvite}
          onCreateProjectBridgeInvite={() => {
            void args.handleCreateProjectBridgeInvite();
          }}
          onOpenBridgeHosts={() => args.setActiveNav('bridge')}
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
        <ChatDetailPanel
          isNativeShell={args.isNativeShell}
          activeDetailTab={args.activeDetailTab}
          activeConv={args.activeConv}
          activeConvHasSubtitle={args.activeConvHasSubtitle}
          activeLastMessage={args.activeLastMessage}
          activeLiveTurn={args.desktopLiveTurn?.sessionId === activeChatSessionId ? args.desktopLiveTurn : null}
          activeConversationIsBridge={args.activeConversationIsBridge}
          activeBridgeConversationHostNodeId={args.activeBridgeConversationHost?.nodeId}
          activeBridgeConversationHostUrl={args.activeBridgeConversationHost?.serverUrl}
          activeBridgeConversation={args.activeBridgeConversation}
          activeBridgeAwaitingReply={args.activeBridgeAwaitingReply}
          isBridgePolling={args.isBridgePolling}
          lastBridgePollAtLabel={args.lastBridgePollAtLabel}
          activeSessionProject={!args.activeConversationIsBridge ? args.activeSessionProject : null}
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
        />
      )}
    </RightDetailRail>
  );
}
