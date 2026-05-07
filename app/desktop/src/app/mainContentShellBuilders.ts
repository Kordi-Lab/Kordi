import type { ComponentProps } from 'react';

import { BridgeConfigPage } from '@/pages/BridgeConfigPage';
import { ChatsPage } from '@/pages/ChatsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { authStateHasChatReadyProvider } from '@/kordi-app/auth/model';
import { bridgeAgentForChatStart } from '@/features/chat/chatCreateFlows';

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
    onCreateBridgeDraft: args.handleCreateBridgeDraft,
    onRefreshBridge: () => {
      void args.refreshDesktopBridge();
    },
    onSaveBridgeSettings: (draftOverride) => args.handleSaveBridgeSettings(draftOverride),
    onRemoveBridgeHost: (hostId) => args.handleRemoveBridgeHost(hostId),
    onCopyBridgeText: (value, successMessage) => {
      void args.handleCopyBridgeText(value, successMessage ?? 'Copied to clipboard');
    },
    onOpenBridgeConfigFolder: args.handleOpenBridgeConfigFolder,
    onRevealBridgeStorageFile: args.handleRevealBridgeStorageFile,
    onExportBridgeHostsConfig: args.handleExportBridgeHostsConfig,
    onImportBridgeHostsConfig: args.handleImportBridgeHostsConfig,
    onAddBridgeContact: args.handleAddBridgeContact,
    onSetBridgeDiscoveryMode: args.handleSetBridgeDiscoveryMode,
    onSetBridgeHostPrivacyPolicy: args.handleSetBridgeHostPrivacyPolicy,
    onSetBridgeAgentReachabilityPolicy: args.handleSetBridgeAgentReachabilityPolicy,
    onApproveBridgeContactRequest: args.handleApproveBridgeContactRequest,
    onRejectBridgeContactRequest: args.handleRejectBridgeContactRequest,
    onCreateBridgeAgent: args.handleCreateBridgeAgent,
    onActivateBridgeAgent: args.handleActivateBridgeAgent,
    onSetDefaultBridgeAgent: args.handleSetDefaultBridgeAgent,
    onRemoveBridgeContact: args.handleRemoveBridgeContact,
    onOpenBridgeConversation: (hostId, peerNodeId, peerDisplayName, peerOwnerName, peerRuntime, target) => {
      const normalizedRuntime = peerRuntime?.trim() ?? '';
      const targetsAgent = Boolean(target?.agentId)
        || (normalizedRuntime.length > 0 && normalizedRuntime.toLowerCase() !== 'person' && isBridgeAgentRuntime(normalizedRuntime));
      const targetsPerson = !targetsAgent;
      if (targetsPerson) {
        void args.handleStartBridgePersonSession({
          hostId,
          nodeId: peerNodeId,
          displayName: peerDisplayName,
          ownerName: peerOwnerName,
          humanId: target?.humanId,
        });
        return;
      }

      void args.handleStartChatWithAgent(bridgeAgentForChatStart({
        hostId,
        nodeId: peerNodeId,
        displayName: peerDisplayName,
        ownerName: peerOwnerName,
        runtime: peerRuntime,
        agentId: target?.agentId,
      }));
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
    onCreateProjectSession: () => {
      void args.handleCreateProjectSession();
    },
    chatTranscriptScrollRef: args.chatTranscriptScrollRef,
    onTranscriptScroll: args.onProjectTranscriptScroll,
    onOpenSource: (file) => {
      args.setActiveSourcePreview(file);
      args.setIsDetailPanelCollapsed(false);
    },
    onOpenArtifact: (artifactId) => {
      args.setActiveSourcePreview(null);
      args.setActiveArtifactId(artifactId);
      args.setActiveDetailTab('artifacts');
      args.setIsDetailPanelCollapsed(false);
    },
    desktopLiveTurn: args.desktopLiveTurn,
    filteredProjectSlashCommands: args.filteredProjectSlashCommands,
    filteredProjectMentionTargets: args.filteredProjectMentionTargets,
    chatSlashMenuIndex: args.chatSlashMenuIndex,
    setChatSlashMenuIndex: args.setChatSlashMenuIndex,
    acceptProjectSlashCommand: args.acceptProjectSlashCommand,
    acceptProjectMentionTarget: args.acceptProjectMentionTarget,
    chatAttachmentInputRef: args.chatAttachmentInputRef,
    chatComposerAttachments: args.chatComposerAttachments,
    saveDesktopAttachments: args.saveDesktopAttachments,
    saveDesktopAttachmentPaths: args.saveDesktopAttachmentPaths,
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
    hasAnyAuth: authStateHasChatReadyProvider(args.desktopAuthState, args.chatModelOptions),
    onOpenAuthSettings: args.openAuthSettings,
  };
}

export function buildChatsPageProps(args: MainContentShellArgs): ComponentProps<typeof ChatsPage> {
  const activeBridgeContactTarget = args.activeConv?.bridgeTarget
    && (args.activeConv.bridgeTarget.runtime?.trim().toLowerCase() === 'person' || args.activeConv.type === 'person')
    ? args.activeConv.bridgeTarget
    : null;

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
    activeBridgeModelHost: args.activeBridgeConversationHost
      ?? args.desktopBridgeState?.hosts.find((host) => host.id === args.activeConv.bridgeTarget?.hostId)
      ?? args.activeBridgeHost,
    desktopChatState: args.desktopChatState,
    onUpdateBridgeAgentModelRouting: args.handleUpdateBridgeAgentModelRouting,
    isEditingDesktopSessionTitle: args.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: args.setIsEditingDesktopSessionTitle,
    desktopSessionRenameDraft: args.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: args.setDesktopSessionRenameDraft,
    onRenameDesktopSession: args.handleRenameDesktopSession,
    chatTranscriptScrollRef: args.chatTranscriptScrollRef,
    onTranscriptScroll: args.onChatTranscriptScroll,
    onOpenSource: (file) => {
      args.setActiveSourcePreview(file);
      args.setIsDetailPanelCollapsed(false);
    },
    onOpenArtifact: (artifactId) => {
      args.setActiveSourcePreview(null);
      args.setActiveArtifactId(artifactId);
      args.setActiveDetailTab('artifacts');
      args.setIsDetailPanelCollapsed(false);
    },
    desktopLiveTurn: args.desktopLiveTurn,
    queuedDesktopMessages: args.activeQueuedDesktopMessages,
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
    onStopBridgeAgentRequest: args.handleStopBridgeAgentRequest,
    onRequestBridgeContact: activeBridgeContactTarget
      ? () => args.handleAddBridgeContact(activeBridgeContactTarget.hostId, activeBridgeContactTarget.nodeId)
      : undefined,
    onSendChatMessage: args.handleSendChatMessage,
    hasAnyAuth: authStateHasChatReadyProvider(args.desktopAuthState, args.chatModelOptions),
    onOpenAuthSettings: args.openAuthSettings,
  };
}
