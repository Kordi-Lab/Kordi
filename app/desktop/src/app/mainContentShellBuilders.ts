import type { ComponentProps } from 'react';

import { BridgeConfigPage } from '@/pages/BridgeConfigPage';
import { ChatsPage } from '@/pages/ChatsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';

import type { MainContentShellArgs } from '@/app/kordiShellSlots.types';

export function buildBridgePageProps(args: MainContentShellArgs): ComponentProps<typeof BridgeConfigPage> {
  return {
    desktopBridgeState: args.desktopBridgeState,
    activeBridgeHost: args.activeBridgeHost,
    activeBridgePeople: args.activeBridgePeople,
    activeBridgeAgents: args.activeBridgeAgents,
    bridgeSettingsDraft: args.bridgeSettingsDraft,
    setBridgeSettingsDraft: args.setBridgeSettingsDraft,
    isDesktopBridgeSaving: args.isDesktopBridgeSaving,
    desktopBridgeError: args.desktopBridgeError,
    bridgeWizardOpen: args.bridgeWizardOpen,
    setBridgeWizardOpen: args.setBridgeWizardOpen,
    bridgeWizardStep: args.bridgeWizardStep,
    setBridgeWizardStep: args.setBridgeWizardStep,
    bridgeWizardDraft: args.bridgeWizardDraft,
    setBridgeWizardDraft: args.setBridgeWizardDraft,
    onSelectBridgeHost: (hostId) => {
      void args.handleSelectBridgeHost(hostId);
    },
    onOpenBridgeWizard: args.openBridgeWizard,
    onCreateBridgeDraft: args.handleCreateBridgeDraft,
    onStartLocalHost: args.handleStartLocalBridgeHost,
    onStopLocalHost: args.handleStopLocalBridgeHost,
    onRefreshBridge: () => {
      void args.refreshDesktopBridge();
    },
    onSaveBridgeSettings: () => {
      void args.handleSaveBridgeSettings();
    },
    onRemoveBridgeHost: (hostId) => {
      void args.handleRemoveBridgeHost(hostId);
    },
    onCopyBridgeText: (value, successMessage) => {
      void args.handleCopyBridgeText(value, successMessage);
    },
    onOpenBridgeConversation: (hostId, peerNodeId, peerDisplayName, peerOwnerName, peerRuntime) => {
      void args.handleOpenBridgeConversation(hostId, peerNodeId, peerDisplayName, peerOwnerName, peerRuntime);
    },
    onBridgeWizardPrimary: () => {
      void args.handleBridgeWizardPrimary();
    },
  };
}

export function buildProjectsPageProps(args: MainContentShellArgs): ComponentProps<typeof ProjectsPage> {
  return {
    isNativeShell: args.isNativeShell,
    collapseChatSessions: args.collapseChatSessions,
    setIsSessionPanelCollapsed: args.setIsSessionPanelCollapsed,
    showRightDetailRail: args.showRightDetailRail,
    isDetailPanelCollapsed: args.isDetailPanelCollapsed,
    setIsDetailPanelCollapsed: args.setIsDetailPanelCollapsed,
    activeProject: args.activeProject,
    activeProjectSession: args.activeProjectSession,
    desktopSessionRenameDraft: args.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: args.setDesktopSessionRenameDraft,
    isEditingDesktopSessionTitle: args.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: args.setIsEditingDesktopSessionTitle,
    onRenameDesktopSession: args.handleRenameDesktopSession,
    activeProjectBridgeHost: args.activeProjectBridgeHost,
    activeProjectBridgeProject: args.activeProjectBridgeProject,
    chatTranscriptScrollRef: args.chatTranscriptScrollRef,
    onTranscriptScroll: args.onProjectTranscriptScroll,
    onOpenSource: (file) => {
      args.setActiveSourcePreview(file);
      args.setIsDetailPanelCollapsed(false);
    },
    desktopLiveTurn: args.desktopLiveTurn,
    filteredProjectSlashCommands: args.filteredProjectSlashCommands,
    chatSlashMenuIndex: args.chatSlashMenuIndex,
    setChatSlashMenuIndex: args.setChatSlashMenuIndex,
    acceptProjectSlashCommand: args.acceptProjectSlashCommand,
    chatAttachmentInputRef: args.chatAttachmentInputRef,
    chatComposerAttachments: args.chatComposerAttachments,
    saveDesktopAttachments: args.saveDesktopAttachments,
    removeChatComposerAttachment: args.removeChatComposerAttachment,
    projectComposerText: args.projectComposerText,
    updateProjectComposerDraft: args.updateProjectComposerDraft,
    setProjectComposerText: args.setProjectComposerText,
    composerControlsRef: args.composerControlsRef,
    activeRuntimeSessionId: args.activeRuntimeSessionId,
    activeRuntimeContextStatus: args.activeRuntimeContextStatus,
    activeRuntimeCacheText: args.activeRuntimeCacheText,
    composerSelection: args.composerSelectionProject,
    openComposerSelector: args.openComposerSelector,
    toggleComposerSelector: args.toggleComposerSelector,
    selectComposerValue: args.selectComposerValue,
    composerAuthLabel: args.composerAuthLabelProject,
    composerAuthOptions: args.composerAuthOptionsProject,
    selectComposerAuthChoice: args.selectComposerAuthChoice,
    selectComposerProviderChoice: args.selectComposerProviderChoice,
    composerProviderOptions: args.composerProviderOptions,
    chatModelOptions: args.chatModelOptions,
    isDesktopChatSending: args.isDesktopChatSending,
    onStopDesktopChatTurn: args.handleStopDesktopChatTurn,
    onSendProjectMessage: args.handleSendProjectMessage,
  };
}

export function buildChatsPageProps(args: MainContentShellArgs): ComponentProps<typeof ChatsPage> {
  return {
    isNativeShell: args.isNativeShell,
    showChatDetailRail: args.showChatDetailRail,
    collapseChatSessions: args.collapseChatSessions,
    setIsSessionPanelCollapsed: args.setIsSessionPanelCollapsed,
    showRightDetailRail: args.showRightDetailRail,
    isDetailPanelCollapsed: args.isDetailPanelCollapsed,
    setIsDetailPanelCollapsed: args.setIsDetailPanelCollapsed,
    activeConv: args.activeConv,
    activeConversationIsBridge: args.activeConversationIsBridge,
    isEditingDesktopSessionTitle: args.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: args.setIsEditingDesktopSessionTitle,
    desktopSessionRenameDraft: args.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: args.setDesktopSessionRenameDraft,
    onRenameDesktopSession: args.handleRenameDesktopSession,
    bridgeStatusText:
      args.isBridgePolling
        ? 'Checking bridge mailbox for replies…'
        : args.activeBridgeConversation?.peerTyping
          ? `${args.activeBridgeConversation.title} is typing…`
          : args.activeBridgeAwaitingReply
            ? `Waiting for ${args.activeBridgeConversation?.title || 'reply'} • next poll soon`
            : `Bridge synced${args.lastBridgePollAtLabel ? ` • last poll ${args.lastBridgePollAtLabel}` : ''}`,
    bridgeStatusLoading: args.isBridgePolling,
    chatTranscriptScrollRef: args.chatTranscriptScrollRef,
    onTranscriptScroll: args.onChatTranscriptScroll,
    onOpenSource: (file) => {
      args.setActiveSourcePreview(file);
      args.setIsDetailPanelCollapsed(false);
    },
    desktopLiveTurn: args.desktopLiveTurn,
    filteredChatSlashCommands: args.filteredChatSlashCommands,
    chatSlashMenuIndex: args.chatSlashMenuIndex,
    setChatSlashMenuIndex: args.setChatSlashMenuIndex,
    acceptChatSlashCommand: args.acceptChatSlashCommand,
    chatAttachmentInputRef: args.chatAttachmentInputRef,
    chatComposerAttachments: args.chatComposerAttachments,
    saveDesktopAttachments: args.saveDesktopAttachments,
    removeChatComposerAttachment: args.removeChatComposerAttachment,
    chatComposerText: args.chatComposerText,
    updateChatComposerDraft: args.updateChatComposerDraft,
    setChatComposerText: args.setChatComposerText,
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
    onSendChatMessage: args.handleSendChatMessage,
  };
}
