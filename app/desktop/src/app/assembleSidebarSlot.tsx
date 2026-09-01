import { useMemo } from 'react';

import { WorkspaceSidebar } from '@/pages/WorkspaceSidebar';
import type { WorkspaceSidebarProps } from '@/pages/WorkspaceSidebar';

import type { SidebarShellArgs } from '@/app/kordiShellSlots.types';
import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import {
  checkDesktopForUpdates,
  installDesktopUpdate,
  openDesktopExternalUrl,
  retryDesktopUpdate,
  subscribeDesktopUpdater,
} from '@/lib/desktop';
import { isPendingIncomingCloudContactRequest, useCloudContacts } from '@/features/cloud/useCloudContacts';
import { normalizeKordiId } from '@/features/cloud/kordiId';
import { authStateSatisfiesStartupGate } from '@/kordi-app/auth/model';
import { usesDefaultLocalAgentSession } from '@/app/openLocalAgentChat';

type SidebarChatActions = Pick<
  WorkspaceSidebarProps['chats'],
  | 'onStartChatWithPerson'
  | 'onStartChatWithAgent'
  | 'onCreateChatGroup'
  | 'onRenameChatGroup'
  | 'onAddChatGroupMembers'
  | 'onRemoveChatGroupMember'
  | 'onSetChatGroupAdmin'
>;

type SidebarSlotProps = {
  args: SidebarShellArgs;
  chatActions: SidebarChatActions;
};

export function assembleSidebarSlot(args: SidebarShellArgs) {
  return (
    <SidebarSlot
      args={args}
      chatActions={{
        onStartChatWithPerson: args.handleStartChatWithPerson,
        onStartChatWithAgent: async (agent) => {
          if (!authStateSatisfiesStartupGate(args.desktopAuthState)) {
            (args.openCloudAccountAuthentication ?? args.openAuthSettings)();
            return;
          }
          if (usesDefaultLocalAgentSession(agent)) {
            await args.handleCreateChatSession();
            return;
          }
          await args.handleStartChatWithAgent(agent);
        },
        onCreateChatGroup: args.handleCreateChatGroup,
        onRenameChatGroup: args.handleRenameChatGroup,
        onAddChatGroupMembers: args.handleAddChatGroupMembers,
        onRemoveChatGroupMember: args.handleRemoveChatGroupMember,
        onSetChatGroupAdmin: args.handleSetChatGroupAdmin,
      }}
    />
  );
}

function SidebarSlot({ args, chatActions }: SidebarSlotProps) {
  const cloudSession = args.cloudSession;
  const cloud = useCloudContacts(cloudSession.account);

  // Cloud profile lookup for the search-first Add-contacts UX in the
  // chat-create dialog. Stable across renders so the dialog doesn't
  // reset its internal state on every keystroke.
  const cloudAuthClient = useMemo(() => defaultCloudAuthClient(), []);
  const onLookupContact = useMemo<
    ((idOrEmail: string) => Promise<AddContactLookupResult | null>) | undefined
  >(() => {
    return async (rawId: string) => {
      const kordiId = normalizeKordiId(rawId);
      if (!kordiId) throw new Error('Enter a nine-digit Kordi ID.');
      const session = await loadSession();
      if (!session?.token) {
        throw new Error('Account is not ready yet.');
      }
      try {
        const profile = await cloudAuthClient.getProfile(session.token, kordiId);
        return {
          accountId: profile.accountId,
          kordiId: profile.kordiId,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          isContact: profile.isContact,
          isSelf: profile.isSelf,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lookup failed.';
        // 404 from the server surfaces as a thrown error; surface a
        // friendlier message instead of cascading the raw HTTP text.
        if (/not[\s_-]?found|404|account_missing/i.test(message)) {
          return null;
        }
        throw err;
      }
    };
  }, [cloudAuthClient]);

  const onAddContactByNodeId = async (rawId: string) => {
    if (!cloudSession.account) {
      throw new Error('Account is not ready yet — try again in a moment.');
    }
    const trimmed = rawId.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('acct_')) {
      throw new Error('Contact could not be added. Search by Kordi ID and try again.');
    }
    await cloud.sendRequest(trimmed);
  };

  return (
    <WorkspaceSidebar
      layout={{
        isNativeShell: args.isNativeShell,
        isSingleWorkspacePage: args.isSingleWorkspacePage,
        collapseChatSessions: args.collapseChatSessions,
        showSessionRail: args.showSessionRail,
        sessionRailWidth: args.sessionRailWidth,
        activeNav: args.activeNav,
        setActiveNav: args.setActiveNav,
        onCheckForUpdates: checkDesktopForUpdates,
        onInstallUpdate: installDesktopUpdate,
        onRetryUpdate: retryDesktopUpdate,
        onSubscribeToUpdate: subscribeDesktopUpdater,
        onOpenUpdateUrl: async (url) => { await openDesktopExternalUrl(url); },
      }}
      chats={{
        chatConversations: args.chatConversations,
        onCreateChatSession: () => {
          void args.handleCreateChatSession();
        },
        chatSearch: args.chatSearch,
        setChatSearch: args.setChatSearch,
        isDesktopChatLoading: args.isDesktopChatLoading,
        desktopChatError: args.desktopChatError,
        participantSpaces: args.participantSpaces,
        archivedParticipantSpaces: args.archivedParticipantSpaces,
        contactParticipantSpaces: args.contactParticipantSpaces,
        agentParticipantSpaces: args.agentParticipantSpaces,
        pinnedSessionIds: args.pinnedChatSessionIds,
        mutedSessionIds: args.mutedChatSessionIds,
        unreadSessionIds: args.unreadChatSessionIds,
        pinnedGroupSpaceIds: args.pinnedChatGroupSpaceIds,
        activeConvId: args.activeConvId,
        onPrefetchChatSession: (sessionId) => {
          void args.handlePrefetchChatSession(sessionId);
        },
        onSelectChatSession: (sessionId) => {
          if (args.unreadChatSessionIds.has(sessionId)) {
            void args.handleSetChatSessionUnread(sessionId, false);
          }
          void args.handleSelectChatSession(sessionId);
        },
        onStartChatWithPerson: chatActions.onStartChatWithPerson,
        onStartChatWithAgent: chatActions.onStartChatWithAgent,
        onCreateChatGroup: chatActions.onCreateChatGroup,
        onAddContactByNodeId,
        onLookupContact,
        addContactPlaceholder: 'Kordi ID, e.g. @482731906',
        onCreateChatSessionInParticipantSpace: args.handleCreateChatSessionInParticipantSpace,
        onRenameChatGroup: chatActions.onRenameChatGroup,
        onRenameChatSession: (sessionId, title) => {
          void args.handleRenameChatSession(sessionId, title);
        },
        onAddChatGroupMembers: chatActions.onAddChatGroupMembers,
        onRemoveChatGroupMember: chatActions.onRemoveChatGroupMember,
        onSetChatGroupAdmin: chatActions.onSetChatGroupAdmin,
        onDeleteChatSession: (sessionId) => {
          void args.handleDeleteChatSession(sessionId);
        },
        onArchiveChatSession: (sessionId) => {
          void args.handleArchiveChatSession(sessionId);
        },
        onRestoreChatSession: (sessionId) => {
          void args.handleRestoreChatSession(sessionId);
        },
        onSetChatSessionPinned: (sessionId, pinned) => {
          void args.handleSetChatSessionPinned(sessionId, pinned);
        },
        onSetChatSessionMuted: (sessionId, muted) => {
          void args.handleSetChatSessionMuted(sessionId, muted);
        },
        onSetChatSessionUnread: (sessionId, unread) => {
          void args.handleSetChatSessionUnread(sessionId, unread);
        },
        onMarkChatSessionsRead: (sessionIds) => {
          void args.handleMarkChatSessionsRead(sessionIds);
        },
        onSetChatGroupPinned: (groupSpaceId, pinned) => {
          void args.handleSetChatGroupPinned(groupSpaceId, pinned);
        },
        isCollaborationSyncing: args.isCollaborationSyncing,
      }}
      projects={{
        onCreateProjectFromFolder: args.handleCreateProjectFromFolder,
        onCreateProject: args.handleCreateProject,
        runtimeProjects: args.runtimeProjects,
        projectSearch: args.projectSearch,
        setProjectSearch: args.setProjectSearch,
        filteredProjects: args.filteredProjects,
        activeProjectId: args.activeProjectId,
        activeProjectSessionId: args.activeProjectSessionId,
        projectSelectedSessionIds: args.projectSelectedSessionIds,
        selectProject: args.selectProject,
        expandedProjectIds: args.expandedProjectIds,
        setExpandedProjectIds: args.setExpandedProjectIds,
        onSelectProjectSession: (projectId, sessionId) => {
          void args.handleSelectProjectSession(projectId, sessionId);
        },
      }}
      directory={{
        groupedContacts: args.groupedContacts,
        displayedContacts: cloud.contacts,
        addableContacts: [],
        contactRequestCount: cloud.requests.filter(isPendingIncomingCloudContactRequest).length,
        setActiveContactGroup: args.setActiveContactGroup,
        setActiveContactId: args.setActiveContactId,
        displayedAgents: args.displayedAgents,
      }}
      account={{
        localProfileAvatarSeed: args.localProfileAvatarSeed,
        cloudAccount: cloudSession.account,
        cloudAccountDialogTab: args.cloudAccountDialogTab,
        setCloudAccountDialogTab: args.setCloudAccountDialogTab,
        cloudSettings: {
          settingsSections: args.settingsSections,
          activeSettingsSectionId: args.activeSettingsSectionId,
          setActiveSettingsSectionId: args.setActiveSettingsSectionId,
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
          themeMode: args.themeMode,
          setThemeMode: args.setThemeMode,
        },
        onUpdateCloudProfile: async (input) => { await cloudSession.updateProfile(input); },
        onCloudSignOut: async () => { await cloudSession.signOut(); },
        onCreateAppInvite: async () => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Account is not ready yet.');
          const invitation = await cloudAuthClient.createAppInvitation(session.token);
          return invitation.inviteUrl;
        },
        onCreateGroupInvite: async (input) => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Account is not ready yet.');
          return cloudAuthClient.createGroupInvitation(session.token, input);
        },
        onListGroupInvites: async (groupSpaceId) => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Account is not ready yet.');
          return cloudAuthClient.listGroupInvitations(session.token, groupSpaceId);
        },
        onRevokeGroupInvite: async (invitationId) => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Account is not ready yet.');
          await cloudAuthClient.revokeGroupInvitation(session.token, invitationId);
        },
      }}
    />
  );
}
