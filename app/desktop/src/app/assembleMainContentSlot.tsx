import { MainContentSwitch } from '@/app/MainContentSwitch';
import { buildChatsPageProps } from '@/app/mainContentShellBuilders';
import { openLocalAgentChatFromArgs } from '@/app/openLocalAgentChat';
import { bridgeAgentForChatStart } from '@/features/chat/chatCreateFlows';
import { CLOUD_HOST_SENTINEL } from '@/features/cloud/useCloudContacts';
import { runDesktopChatSkillCommand } from '@/lib/desktop';

import type { MainContentShellArgs } from '@/app/kordiShellSlots.types';

export function assembleMainContentSlot(args: MainContentShellArgs) {
  const openLocalAgentChat = (preferredModelValue?: string) => openLocalAgentChatFromArgs(args, preferredModelValue);

  return (
    <MainContentSwitch
      activeNav={args.activeNav}
      cloudSession={args.cloudSession}
      contactsPageProps={{
        filteredGroupedContacts: args.filteredGroupedContacts,
        addableContacts: args.addableContacts,
        isContactRequestsOpen: args.isContactRequestsOpen,
        onToggleRequests: () => args.setIsContactRequestsOpen((open) => !open),
        contactRequests: args.contactRequests,
        activeContactRequestId: args.activeContactRequestId,
        onAcceptRequest: async (request) => {
          if (!request.bridgeHostId || !request.bridgeRequestId) return;
          await args.handleApproveBridgeContactRequest(request.bridgeHostId, request.bridgeRequestId);
          args.setContactOverlayMode(null);
        },
        onRejectRequest: async (request) => {
          if (!request.bridgeHostId || !request.bridgeRequestId) return;
          await args.handleRejectBridgeContactRequest(request.bridgeHostId, request.bridgeRequestId);
          args.setContactOverlayMode(null);
        },
        onAddContactByNodeId: async (nodeId) => {
          if (!args.activeBridgeHost?.id) {
            throw new Error('Set up a Bridge host before adding contacts.');
          }
          await args.handleAddBridgeContact(args.activeBridgeHost.id, nodeId);
        },
        onRemoveContact: async (contact) => {
          if (!contact.bridgeHostId || !contact.bridgePeerNodeId) return;
          await args.handleRemoveBridgeContact(contact.bridgeHostId, contact.bridgePeerNodeId);
          args.setContactOverlayMode(null);
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

          if (contact.bridgeHostId === CLOUD_HOST_SENTINEL) {
            void args.handleOpenBridgeConversation(
              contact.bridgeHostId,
              contact.bridgePeerNodeId,
              contact.name,
              contact.owner,
              contactTargetsAgent ? contact.bridgePeerRuntime : 'person',
            );
            return;
          }

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
        localProfileAvatarSeed: args.localProfileAvatarSeed,
        localProfileDisplayName: args.localProfileDisplayName,
        localProfileImageUrl: args.localProfileImageUrl,
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
          if (agent.cloudAgentId) {
            void args.handleStartChatWithAgent(agent);
            return;
          }

          if (agent.isOwned) {
            void openLocalAgentChat();
            return;
          }

          void args.handleStartChatWithAgent(agent);
        },
        onOpenAgentReachoutSession: (sessionId) => {
          args.setActiveNav('chats');
          void args.handleSelectChatSession(sessionId);
        },
        onOpenAgentBuilderSession: (sessionId) => {
          args.setActiveNav('chats');
          void args.handleSelectChatSession(sessionId);
        },
        onOpenAuthSettings: args.openCloudAccountAuthentication ?? args.openAuthSettings,
        onCreateCloudAgent: args.handleCreateCloudAgent,
        onUpdateCloudAgent: args.handleUpdateCloudAgent,
        onArchiveCloudAgent: args.handleArchiveCloudAgent,
        onSetAgentSkillEnabled: async (agent, skill, enabled) => {
          if (!agent.isOwned || (agent.id !== 'desktop:local-agent' && !agent.isBridgeActive)) {
            throw new Error('Only the active local Kordi agent can change runtime skills here.');
          }
          const sessionId = args.desktopChatState?.activeSessionId?.trim();
          if (!sessionId) {
            throw new Error('Open a local Kordi chat once before changing runtime skills.');
          }
          const result = await runDesktopChatSkillCommand(
            sessionId,
            `/skill ${enabled ? 'enable' : 'disable'} ${skill}`,
          );
          const succeeded = enabled
            ? result.startsWith('Enabled skill:') || result.includes('is not disabled.')
            : result.startsWith('Disabled skill:') || result.includes('is already disabled.');
          if (!succeeded) throw new Error(result || `Kordi could not ${enabled ? 'enable' : 'disable'} ${skill}.`);
          await args.refreshDesktopChat(sessionId);
        },
      }}
      chatsPageProps={buildChatsPageProps(args)}
    />
  );
}
