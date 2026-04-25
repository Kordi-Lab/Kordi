import { MainContentSwitch } from '@/app/MainContentSwitch';
import { buildBridgePageProps, buildChatsPageProps, buildProjectsPageProps } from '@/app/mainContentShellBuilders';
import { findCanonicalConversationForTarget } from '@/features/canonical/sessionReadModel';

import type { MainContentShellArgs } from '@/app/kordiShellSlots.types';

export function assembleMainContentSlot(args: MainContentShellArgs) {
  const openLocalAgentChat = async () => {
    args.setActiveNav('chats');
    const existingLocalConversation = args.chatConversations.find(
      (conversation) => conversation.type === 'owned-agent' && !conversation.id.startsWith('bridge:'),
    );
    if (existingLocalConversation) {
      await args.handleSelectChatSession(existingLocalConversation.id);
      return;
    }
    await args.handleCreateChatSession();
  };

  return (
    <MainContentSwitch
      activeNav={args.activeNav}
      contactsPageProps={{
        filteredGroupedContacts: args.filteredGroupedContacts,
        isContactRequestsOpen: args.isContactRequestsOpen,
        onToggleRequests: () => args.setIsContactRequestsOpen((open) => !open),
        contactRequests: args.contactRequests,
        activeContactRequestId: args.activeContactRequestId,
        onReviewRequest: (requestId) => {
          args.setActiveContactRequestId(requestId);
          args.setContactOverlayMode('request');
        },
        contactSearch: args.contactSearch,
        onContactSearchChange: args.setContactSearch,
        expandedContactGroups: args.expandedContactGroups,
        onToggleGroup: (groupId) => args.setExpandedContactGroups((current) => ({ ...current, [groupId]: !current[groupId] })),
        activeContactId: args.activeContactId,
        onSelectContact: (groupId, contactId) => {
          args.setActiveContactGroup(groupId);
          args.setActiveContactId(contactId);
          args.setContactOverlayMode('contact');
        },
        contactOverlayMode: args.contactOverlayMode,
        activeContact: args.activeContact,
        activeContactRequest: args.activeContactRequest,
        onCloseOverlay: () => args.setContactOverlayMode(null),
        getStatusBadgeClass: args.getStatusBadgeClass,
        onMessageContact: (contact) => {
          if (contact.id.startsWith('bridge-self:') || contact.classType === 'my-agents') {
            void openLocalAgentChat();
            return;
          }

          const existingConversation = findCanonicalConversationForTarget(args.chatConversations, {
            humanId: contact.bridgeHumanId,
            agentId: contact.bridgeAgentId,
            bridgeNodeId: contact.bridgePeerNodeId,
          });
          if (existingConversation) {
            void args.handleSelectChatSession(existingConversation.id);
            return;
          }

          if (!contact.bridgeHostId || !contact.bridgePeerNodeId) return;
          void args.handleOpenBridgeConversation(contact.bridgeHostId, contact.bridgePeerNodeId, contact.name, contact.owner, contact.bridgePeerRuntime);
        },
      }}
      agentsPageProps={{
        agents: args.displayedAgents,
        activeAgentId: args.activeAgentId,
        activeAgent: args.activeAgent,
        onOpenAgent: (agentId) => {
          args.setActiveAgentId(agentId);
          args.setIsAgentOverlayOpen(false);
        },
        getStatusBadgeClass: args.getStatusBadgeClass,
        onMessageAgent: (agent) => {
          if (agent.isOwned) {
            void openLocalAgentChat();
            return;
          }

          const existingConversation = findCanonicalConversationForTarget(args.chatConversations, {
            agentId: agent.bridgeAgentId,
            bridgeNodeId: agent.bridgePeerNodeId,
          });
          if (existingConversation) {
            void args.handleSelectChatSession(existingConversation.id);
            return;
          }

          if (!agent.bridgeHostId || !agent.bridgePeerNodeId) return;
          void args.handleOpenBridgeConversation(agent.bridgeHostId, agent.bridgePeerNodeId, agent.name, undefined, agent.bridgePeerRuntime);
        },
      }}
      bridgePageProps={buildBridgePageProps(args)}
      settingsPageProps={{
        settingsRailWidth: args.settingsRailWidth,
        settingsContentRef: args.settingsContentRef,
        activeSettingsSectionId: args.activeSettingsSectionId,
        setActiveSettingsSectionId: args.setActiveSettingsSectionId,
        settingsSections: args.settingsSections,
        activeSettingsSection: args.activeSettingsSection,
        authSettingsLayoutWidth: args.authSettingsLayoutWidth,
        isNativeShell: args.isNativeShell,
        desktopAuthState: args.desktopAuthState,
        isDesktopAuthLoading: args.isDesktopAuthLoading,
        desktopAuthError: args.desktopAuthError,
        activeLoginProviderId: args.activeLoginProviderId,
        selectAuthProvider: args.selectAuthProvider,
        openLoginFlow: args.openLoginFlow,
        refreshDesktopAuth: args.refreshDesktopAuth,
        handleSelectAuthChoice: args.handleSelectAuthChoice,
        handleRemoveAuthProfile: args.handleRemoveAuthProfile,
        handleLogoutProvider: args.handleLogoutProvider,
        projectSettingsDraft: args.projectSettingsDraft,
        isDesktopProjectSaving: args.isDesktopProjectSaving,
        desktopProjectError: args.desktopProjectError,
        handleSaveProjectSettings: args.handleSaveProjectSettings,
        updateProjectSettingsDraft: args.updateProjectSettingsDraft,
        themeMode: args.themeMode,
        setThemeMode: args.setThemeMode,
      }}
      projectsPageProps={buildProjectsPageProps(args)}
      chatsPageProps={buildChatsPageProps(args)}
    />
  );
}
