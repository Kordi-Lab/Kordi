import type { ComponentProps } from 'react';

import { ChatsPage } from '@/pages/ChatsPage';
import { authStateSatisfiesStartupGate } from '@/kordi-app/auth/model';

import type { MainContentShellArgs } from '@/app/kordiShellSlots.types';

export function buildChatsPageProps(args: MainContentShellArgs): ComponentProps<typeof ChatsPage> {
  const activeCollaborationContactTarget = args.activeConv?.collaborationTarget
    && (args.activeConv.collaborationTarget.runtime?.trim().toLowerCase() === 'person' || args.activeConv.type === 'person')
    ? args.activeConv.collaborationTarget
    : null;
  const activeCloudSelfAgentSessionId = args.activeConv?.canonicalSessionId ?? args.activeConv?.id ?? '';

  return {
    layout: {
    isNativeShell: args.isNativeShell,
    showChatDetailRail: args.showChatDetailRail,
    collapseChatSessions: args.collapseChatSessions,
    setIsSessionPanelCollapsed: args.setIsSessionPanelCollapsed,
    showRightDetailRail: args.showRightDetailRail,
    isDetailPanelCollapsed: args.isDetailPanelCollapsed,
    setIsDetailPanelCollapsed: args.setIsDetailPanelCollapsed,
    rightDetailRail: args.rightDetailRail,
    detailRailWidth: args.detailRailWidth,
    activeDetailTab: args.activeDetailTab,
    setActiveDetailTab: args.setActiveDetailTab,
    activeArtifactId: args.activeArtifactId,
    setActiveArtifactId: args.setActiveArtifactId,
    onDetailResizeMouseDown: args.onDetailResizeMouseDown,
    },
    session: {
    activeConv: args.activeConv,
    chatConversations: args.chatConversations,
    activeConversationUsesCollaboration: args.activeConversationUsesCollaboration,
    activeCollaborationModelHost: args.activeCollaborationConversationHost
      ?? args.desktopCollaborationState?.hosts.find((host) => host.id === args.activeConv.collaborationTarget?.hostId)
      ?? args.activeCollaborationHost,
    desktopChatState: args.desktopChatState,
    cloudAccount: args.cloudSession?.account ?? null,
    cloudSessionPin: args.cloudSessionPinsById?.[activeCloudSelfAgentSessionId] ?? null,
    onUpdateCloudSessionPin: args.onUpdateCloudSessionPin,
    onUpdateCollaborationAgentModelRouting: args.handleUpdateCollaborationAgentModelRouting,
    isEditingDesktopSessionTitle: args.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: args.setIsEditingDesktopSessionTitle,
    desktopSessionRenameDraft: args.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: args.setDesktopSessionRenameDraft,
    onRenameDesktopSession: args.handleRenameDesktopSession,
    onRenameChatSession: args.handleRenameChatSession,
    },
    transcript: {
    chatTranscriptScrollRef: args.chatTranscriptScrollRef,
    canonicalHasOlderBySessionId: args.canonicalHasOlderBySessionId,
    onLoadOlderCanonicalSessionMessages: args.loadOlderCanonicalSessionMessages,
    onTranscriptScroll: args.onChatTranscriptScroll,
    onOpenSource: (file) => {
      args.setActiveSourcePreview(file);
      args.setActiveDetailTab('artifacts');
      args.setIsDetailPanelCollapsed(false);
    },
    onClearSourcePreview: () => args.setActiveSourcePreview(null),
    onOpenArtifact: (artifactId) => {
      args.setActiveSourcePreview(null);
      args.setActiveArtifactId(artifactId);
      args.setActiveDetailTab('artifacts');
      args.setIsDetailPanelCollapsed(false);
    },
    desktopLiveTurn: args.desktopLiveTurn,
    queuedDesktopMessages: args.activeQueuedDesktopMessages,
    queuedDesktopMessagesBySession: args.queuedDesktopMessagesBySession,
    onEditQueuedMessage: args.handleEditQueuedMessage,
    onCancelQueuedMessage: args.handleCancelQueuedMessage,
    },
    composer: {
    filteredChatSlashCommands: args.filteredChatSlashCommands,
    filteredChatMentionTargets: args.filteredChatMentionTargets,
    chatSlashMenuIndex: args.chatSlashMenuIndex,
    setChatSlashMenuIndex: args.setChatSlashMenuIndex,
    acceptChatSlashCommand: args.acceptChatSlashCommand,
    acceptChatMentionTarget: args.acceptChatMentionTarget,
    chatAttachmentInputRef: args.chatAttachmentInputRef,
    chatComposerAttachments: args.chatComposerAttachments,
    saveDesktopAttachments: args.saveDesktopAttachments,
    saveDesktopAttachmentPaths: args.saveDesktopAttachmentPaths,
    removeChatComposerAttachment: args.removeChatComposerAttachment,
    updateChatComposerAttachment: args.updateChatComposerAttachment,
    chatComposerText: args.chatComposerText,
    updateChatComposerDraft: args.updateChatComposerDraft,
    setChatComposerText: args.setChatComposerText,
    setChatComposerTextForSession: args.setChatComposerTextForSession,
    activeChatQuote: args.activeChatQuote,
    onClearChatQuote: args.onClearChatQuote,
    onReplyMessage: args.onReplyMessage,
    onForwardMessage: args.onForwardMessage,
    onSelectMessage: args.onSelectMessage,
    messageSelectionMode: args.messageSelectionMode,
    selectedMessageCount: args.selectedMessageCount,
    selectedMessageIds: args.selectedMessageIds,
    isMessageSelectable: args.isMessageSelectable,
    onToggleSelectedMessage: args.onToggleSelectedMessage,
    onSelectionDragStart: args.onSelectionDragStart,
    onSelectionDragEnter: args.onSelectionDragEnter,
    onSelectionDragEnd: args.onSelectionDragEnd,
    onCancelMessageSelection: args.onCancelMessageSelection,
    onSelectAllMessages: args.onSelectAllMessages,
    onCopySelectedMessages: args.onCopySelectedMessages,
    onForwardSelectedMessages: args.onForwardSelectedMessages,
    },
    runtime: {
    composerControlsRef: args.composerControlsRef,
    activeRuntimeContextStatus: args.activeRuntimeContextStatus,
    activeRuntimeCacheText: args.activeRuntimeCacheText,
    composerSelection: args.composerSelectionChat,
    openComposerSelector: args.openComposerSelector,
    toggleComposerSelector: args.toggleComposerSelector,
    selectComposerValue: args.selectComposerValue,
    composerAuthLabel: args.composerAuthLabelChat,
    composerAuthOptions: args.composerAuthOptionsChat,
    selectComposerAuthChoice: args.selectComposerAuthChoice,
    selectComposerProviderChoice: args.selectComposerProviderChoice,
    composerProviderOptions: args.composerProviderOptions,
    chatModelOptions: args.chatModelOptions,
    isDesktopChatSending: args.isDesktopChatSending,
    onStopDesktopChatTurn: args.handleStopDesktopChatTurn,
    onStopCollaborationAgentRequest: args.handleStopCollaborationAgentRequest,
    onRequestCollaborationContact: activeCollaborationContactTarget
      ? () => args.handleAddCollaborationContact(activeCollaborationContactTarget.hostId, activeCollaborationContactTarget.nodeId)
      : undefined,
    onMessageContact: args.handleStartChatWithPerson,
    onSendChatMessage: args.handleSendChatMessage,
    onRetryChatMessage: args.handleRetryChatMessage,
    onCreateAgentSession: args.handleCreateSideAgentSession,
    onForkChatMessage: args.handleForkChatMessage,
    onSelectSession: args.handleSelectChatSession,
    onPrefetchChatSession: args.handlePrefetchChatSession,
    },
    auth: {
    hasAnyAuth: authStateSatisfiesStartupGate(args.desktopAuthState),
    onOpenAuthSettings: args.openAuthSettings,
    onOpenAccountAuthentication: args.openCloudAccountAuthentication,
    },
  };
}
