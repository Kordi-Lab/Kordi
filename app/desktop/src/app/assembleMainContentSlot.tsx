import { MainContentSwitch } from '@/app/MainContentSwitch';
import {
  buildBridgePageProps,
  buildChatsPageProps,
  buildProjectsPageProps,
} from '@/app/mainContentShellBuilders';
import { findOwnedAgentConversation } from '@/features/canonical/sessionResolver';
import { bridgeAgentForChatStart } from '@/features/chat/chatCreateFlows';
import { createDesktopChatSession, updateDesktopChatSessionConfig } from '@/lib/desktop';

import type { MainContentShellArgs } from '@/app/kordiShellSlots.types';

export function assembleMainContentSlot(args: MainContentShellArgs) {
  const openLocalAgentChat = async (preferredModelValue?: string) => {
    args.setActiveNav('chats');
    const existingLocalConversation = findOwnedAgentConversation(args.chatConversations);

    if (!preferredModelValue) {
      if (existingLocalConversation) {
        await args.handleSelectChatSession(existingLocalConversation.id);
      } else {
        await args.handleCreateChatSession();
      }
      return;
    }

    const sessionId = existingLocalConversation?.id ?? (await createDesktopChatSession()).activeSessionId;
    await updateDesktopChatSessionConfig(sessionId, preferredModelValue);
    await args.handleSelectChatSession(sessionId);
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

          const contactTargetsAgent = contact.classType === 'other-users-agents';
          args.setContactOverlayMode(null);
          if (!contact.bridgeHostId || !contact.bridgePeerNodeId) return;

          if (!contactTargetsAgent) {
            void args.handleStartBridgePersonSession({
              hostId: contact.bridgeHostId,
              nodeId: contact.bridgePeerNodeId,
              displayName: contact.name,
              ownerName: contact.owner,
              humanId: contact.bridgeHumanId,
            });
            return;
          }

          void args.handleStartChatWithAgent(bridgeAgentForChatStart({
            hostId: contact.bridgeHostId,
            nodeId: contact.bridgePeerNodeId,
            displayName: contact.name,
            ownerName: contact.owner,
            runtime: contact.bridgePeerRuntime,
            agentId: contact.bridgeAgentId,
            contactId: contact.id,
            profileImageUrl: contact.profileImageUrl,
          }));
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
        chatModelOptions: args.chatModelOptions,
        composerProviderOptions: args.composerProviderOptions,
        onUpdateAgentModelRouting: (agent, values) => {
          if (!agent.bridgeHostId || !agent.bridgeAgentId) {
            return args.handleUpdateLocalAgentModelRouting(
              values.defaultModel,
              values.fallbackModel,
              values.thinking,
              values.defaultAuthProvider,
              values.defaultAuthChoice,
              values.fallbackAuthProvider,
              values.fallbackAuthChoice,
            );
          }
          return args.handleUpdateBridgeAgentModelRouting(
            agent.bridgeHostId,
            agent.bridgeAgentId,
            values.defaultModel,
            values.fallbackModel,
            values.thinking,
            values.defaultAuthProvider,
            values.defaultAuthChoice,
            values.fallbackAuthProvider,
            values.fallbackAuthChoice,
          );
        },
        onMessageAgent: (agent) => {
          if (agent.isOwned) {
            void openLocalAgentChat();
            return;
          }

          void args.handleStartChatWithAgent(agent);
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
        localProfileAvatarSeed: args.localProfileAvatarSeed,
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
        onEnterChat: openLocalAgentChat,
        themeMode: args.themeMode,
        setThemeMode: args.setThemeMode,
      }}
      projectsPageProps={buildProjectsPageProps(args)}
      chatsPageProps={buildChatsPageProps(args)}
    />
  );
}
