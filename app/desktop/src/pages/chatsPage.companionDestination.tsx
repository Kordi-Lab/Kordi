import type { Dispatch, SetStateAction } from 'react';

import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { extractSessionArtifacts } from '@/features/chat/artifacts';
import type {
  Conversation,
  DesktopChatTurnSnapshot,
  EditFilePreview,
} from '@/kordi-app/types';
import { ChatDetailPanel } from '@/pages/ChatDetailPanel';
import { RightDetailRail } from '@/pages/RightDetailRail';
import {
  CHAT_DETAIL_TABS,
  detailDestinationFromTab,
  type ChatDestination,
  type ChatDetailDestination,
} from '@/pages/chatsPage.destinationModel';

type CompanionDestinationActions = {
  setDestination: Dispatch<SetStateAction<ChatDestination>>;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  setActiveSourcePreview: Dispatch<SetStateAction<EditFilePreview | null>>;
  onNavigateToResponse: (messageId: string) => void;
  onOpenOutreachThread?: (sessionId: string) => void;
};

type CompanionDestinationPageProps = {
  conversation: Conversation;
  destination: ChatDetailDestination;
  isNativeShell: boolean;
  liveTurn: DesktopChatTurnSnapshot | null | undefined;
  activeArtifactId: string | null;
  activeSourcePreview: EditFilePreview | null;
  actions: CompanionDestinationActions;
};

export function CompanionDestinationPage({
  conversation,
  destination,
  isNativeShell,
  liveTurn,
  activeArtifactId,
  activeSourcePreview,
  actions,
}: CompanionDestinationPageProps) {
  const artifacts = extractSessionArtifacts(
    conversation.messages,
    liveTurn ?? undefined,
    conversation.reflectionLessonArtifacts,
  );
  const activeLiveTurn =
    liveTurn?.sessionId === conversation.id
    || liveTurn?.sessionId === conversation.canonicalSessionId
      ? liveTurn
      : null;

  return (
    <div
      id={`chat-companion-${destination}-panel`}
      className="min-h-0 min-w-0 flex-1 overflow-hidden"
      role="tabpanel"
      aria-labelledby={`chat-companion-${destination}-tab`}
      data-chat-destination-page={destination}
      data-chat-destination-scope="companion"
    >
      <RightDetailRail
        variant="page"
        detailTabs={CHAT_DETAIL_TABS}
        activeDetailTab={destination}
        onSelectDetailTab={(tab) => {
          actions.setActiveSourcePreview(null);
          actions.setDestination(detailDestinationFromTab(tab));
        }}
        activeSourcePreview={activeSourcePreview}
        onCloseSourcePreview={() => actions.setActiveSourcePreview(null)}
      >
        <ChatDetailPanel
          isNativeShell={isNativeShell}
          activeDetailTab={destination}
          activeConv={conversation}
          activeConvHasSubtitle={Boolean(formatSessionIdSubtitle(conversation.subtitle))}
          activeLastMessage={conversation.messages[conversation.messages.length - 1]}
          activeLiveTurn={activeLiveTurn}
          activeConversationUsesCollaboration={false}
          activeCollaborationConversationHostNodeId={null}
          activeCollaborationConversationHostUrl={null}
          activeCollaborationConversation={null}
          activeCollaborationAwaitingReply={false}
          isCollaborationSyncing={false}
          lastCollaborationSyncAtLabel={null}
          activeSessionProject={null}
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onSelectArtifact={actions.setActiveArtifactId}
          onOpenArtifact={(artifactId) => {
            actions.setActiveSourcePreview(null);
            actions.setActiveArtifactId(artifactId);
            actions.setDestination('artifacts');
          }}
          onNavigateToResponse={actions.onNavigateToResponse}
          onOpenOutreachThread={actions.onOpenOutreachThread}
        />
      </RightDetailRail>
    </div>
  );
}
