import { MainContentSwitch } from '@/app/MainContentSwitch';
import { buildChatsPageProps } from '@/app/mainContentShellBuilders';
import { openLocalAgentChatFromArgs, usesDefaultLocalAgentSession } from '@/app/openLocalAgentChat';
import { collaborationAgentForChatStart } from '@/features/chat/chatCreateFlows';
import { isCollaborationSelfContactId } from '@/features/collaboration/legacyBridgeCompatibility';
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
          if (!request.sourceHostId || !request.sourceRequestId) return;
          await args.handleApproveCollaborationContactRequest(request.sourceHostId, request.sourceRequestId);
          args.setContactOverlayMode(null);
        },
        onRejectRequest: async (request) => {
          if (!request.sourceHostId || !request.sourceRequestId) return;
          await args.handleRejectCollaborationContactRequest(request.sourceHostId, request.sourceRequestId);
          args.setContactOverlayMode(null);
        },
        onAddContactByNodeId: async (nodeId) => {
          if (!args.activeCollaborationHost?.id) {
            throw new Error('A collaboration host is required before adding contacts.');
          }
          await args.handleAddCollaborationContact(args.activeCollaborationHost.id, nodeId);
        },
        onRemoveContact: async (contact) => {
          if (!contact.sourceHostId || !contact.sourceParticipantId) return;
          await args.handleRemoveCollaborationContact(contact.sourceHostId, contact.sourceParticipantId);
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
          if (isCollaborationSelfContactId(contact.id) || contact.classType === 'my-agents') {
            void openLocalAgentChat();
            return;
          }

          const contactTargetsAgent = contact.classType === 'other-users-agents';
          args.setContactOverlayMode(null);
          if (!contact.sourceHostId || !contact.sourceParticipantId) return;

          if (contact.systemContact) {
            void args.handleStartChatWithPerson(contact);
            return;
          }

          if (contact.sourceHostId === CLOUD_HOST_SENTINEL) {
            void args.handleOpenCollaborationConversation(
              contact.sourceHostId,
              contact.sourceParticipantId,
              contact.name,
              contact.owner,
              contactTargetsAgent ? contact.sourceRuntime : 'person',
            );
            return;
          }

          if (!contactTargetsAgent) {
            void args.handleStartCollaborationPersonSession({
              hostId: contact.sourceHostId,
              nodeId: contact.sourceParticipantId,
              displayName: contact.name,
              ownerName: contact.owner,
              humanId: contact.sourceHumanId,
            });
            return;
          }

          void args.handleStartChatWithAgent(collaborationAgentForChatStart({
            hostId: contact.sourceHostId,
            nodeId: contact.sourceParticipantId,
            displayName: contact.name,
            ownerName: contact.owner,
            runtime: contact.sourceRuntime,
            agentId: contact.sourceAgentId,
            contactId: contact.id,
            profileImageUrl: contact.profileImageUrl,
          }));
        },
      }}
      agentsPageProps={{
        agents: args.displayedAgents,
        activeAgentId: args.activeAgentId,
        activeAgent: args.activeAgent,
        cloudAccountId: args.cloudSession?.account?.accountId,
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
        defaultAgentRuntimeRoute: args.defaultCloudAgentRuntimeRoute,
        onUpdateAgentModelRouting: (agent, values) => {
          if (!agent.sourceHostId || !agent.sourceAgentId) {
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
          return args.handleUpdateCollaborationAgentModelRouting(
            agent.sourceHostId,
            agent.sourceAgentId,
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
          if (usesDefaultLocalAgentSession(agent)) {
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
          if (!agent.isOwned || (agent.id !== 'desktop:local-agent' && !agent.isCollaborationActive)) {
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
