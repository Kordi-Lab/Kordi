import { useMemo } from 'react';
import type { ComponentProps } from 'react';

import { WorkspaceSidebar } from '@/pages/WorkspaceSidebar';

import type { SidebarShellArgs } from '@/app/kordiShellSlots.types';
import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { currentKordiEdition } from '@/features/cloud/edition';
import { loadSession } from '@/features/cloud/session';
import { isPendingIncomingCloudContactRequest, useCloudContacts } from '@/features/cloud/useCloudContacts';
import { useCloudSession } from '@/features/cloud/useCloudSession';

type SidebarSlotProps = { args: SidebarShellArgs } & Partial<ComponentProps<typeof WorkspaceSidebar>>;

export function assembleSidebarSlot(args: SidebarShellArgs) {
  return (
    <SidebarSlot
      args={args}
      onStartChatWithPerson={args.handleStartChatWithPerson}
      onStartChatWithAgent={async (agent) => {
        if (agent.isOwned) {
          await args.handleCreateChatSession();
          return;
        }
        await args.handleStartChatWithAgent(agent);
      }}
      onCreateChatGroup={args.handleCreateChatGroup}
      onRenameChatGroup={args.handleRenameChatGroup}
      onAddChatGroupMembers={args.handleAddChatGroupMembers}
      onRemoveChatGroupMember={args.handleRemoveChatGroupMember}
      onSetChatGroupAdmin={args.handleSetChatGroupAdmin}
    />
  );
}

function SidebarSlot({ args }: SidebarSlotProps) {
  // Hooks must run on every render; the cloud branch only takes effect
  // when the desktop is launched in cloud edition.
  const edition = currentKordiEdition();
  const cloudSession = useCloudSession({ enabled: edition === 'cloud' });
  const cloud = useCloudContacts(edition === 'cloud' ? cloudSession.account : null);

  // Bridge path is unreachable in cloud edition — gate purely on
  // edition so a race between the parent shell's session bootstrap
  // and this slot's bootstrap can't trip a "Set up a Bridge host"
  // error on cloud users.
  const isCloud = edition === 'cloud';

  // Cloud-mode profile lookup for the search-first Add-contacts UX in
  // the chat-create dialog. Stable across renders so the dialog
  // doesn't reset its internal state on every keystroke.
  const cloudAuthClient = useMemo(() => defaultCloudAuthClient(), []);
  const onLookupContact = useMemo<
    ((idOrEmail: string) => Promise<AddContactLookupResult | null>) | undefined
  >(() => {
    if (!isCloud) return undefined;
    return async (rawId: string) => {
      const trimmed = rawId.trim();
      if (!trimmed) return null;
      if (!trimmed.startsWith('acct_')) {
        throw new Error('Cloud account IDs start with "acct_".');
      }
      const session = await loadSession();
      if (!session?.token) {
        throw new Error('Cloud session not ready yet.');
      }
      try {
        const profile = await cloudAuthClient.getProfile(session.token, trimmed);
        return {
          accountId: profile.accountId,
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
  }, [isCloud, cloudAuthClient]);

  const onAddContactByNodeId = async (rawId: string) => {
    if (isCloud) {
      if (!cloudSession.account) {
        throw new Error('Cloud session not ready yet — try again in a moment.');
      }
      const trimmed = rawId.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('acct_')) {
        throw new Error('Cloud account IDs start with "acct_".');
      }
      await cloud.sendRequest(trimmed);
      return;
    }
    if (!args.activeBridgeHost?.id) {
      throw new Error('Set up a Bridge host before adding contacts.');
    }
    await args.handleAddBridgeContact(args.activeBridgeHost.id, rawId);
  };

  return (
    <WorkspaceSidebar
        isNativeShell={args.isNativeShell}
        isSingleWorkspacePage={args.isSingleWorkspacePage}
        collapseChatSessions={args.collapseChatSessions}
        showSessionRail={args.showSessionRail}
        sessionRailWidth={args.sessionRailWidth}
        activeNav={args.activeNav}
        setActiveNav={args.setActiveNav}
        chatConversations={args.chatConversations}
        onCreateChatSession={() => {
          void args.handleCreateChatSession();
        }}
        chatSearch={args.chatSearch}
        setChatSearch={args.setChatSearch}
        isDesktopChatLoading={args.isDesktopChatLoading}
        desktopChatError={args.desktopChatError}
        participantSpaces={args.participantSpaces}
        contactParticipantSpaces={args.contactParticipantSpaces}
        agentParticipantSpaces={args.agentParticipantSpaces}
        activeConvId={args.activeConvId}
        onSelectChatSession={(sessionId) => {
          void args.handleSelectChatSession(sessionId);
        }}
        onStartChatWithPerson={(contact) => {
          void args.handleStartChatWithPerson(contact);
        }}
        onStartChatWithAgent={async (agent) => {
          if (agent.isOwned) {
            await args.handleCreateChatSession();
            return;
          }
          await args.handleStartChatWithAgent(agent);
        }}
        onCreateChatGroup={args.handleCreateChatGroup}
        onAddContactByNodeId={onAddContactByNodeId}
        onLookupContact={onLookupContact}
        addContactPlaceholder={isCloud ? 'Account ID, e.g. acct_…' : undefined}
        onCreateChatSessionInParticipantSpace={args.handleCreateChatSessionInParticipantSpace}
        onRenameChatGroup={args.handleRenameChatGroup}
        onRenameChatSession={(sessionId, title) => {
          void args.handleRenameChatSession(sessionId, title);
        }}
        onAddChatGroupMembers={args.handleAddChatGroupMembers}
        onRemoveChatGroupMember={args.handleRemoveChatGroupMember}
        onSetChatGroupAdmin={args.handleSetChatGroupAdmin}
        onArchiveChatSession={(sessionId) => {
          void args.handleArchiveChatSession(sessionId);
        }}
        onDeleteChatSession={(sessionId) => {
          void args.handleDeleteChatSession(sessionId);
        }}
        onMoveChatSessionToProject={(sessionId, projectRoot) => {
          void args.handleMoveChatSessionToProject(sessionId, projectRoot);
        }}
        onCreateProjectFromFolder={args.handleCreateProjectFromFolder}
        onCreateProject={args.handleCreateProject}
        runtimeProjects={args.runtimeProjects}
        projectSearch={args.projectSearch}
        setProjectSearch={args.setProjectSearch}
        filteredProjects={args.filteredProjects}
        activeProjectId={args.activeProjectId}
        activeProjectSessionId={args.activeProjectSessionId}
        projectSelectedSessionIds={args.projectSelectedSessionIds}
        selectProject={args.selectProject}
        expandedProjectIds={args.expandedProjectIds}
        setExpandedProjectIds={args.setExpandedProjectIds}
        onSelectProjectSession={(projectId, sessionId) => {
          void args.handleSelectProjectSession(projectId, sessionId);
        }}
        groupedContacts={args.groupedContacts}
        displayedContacts={isCloud ? cloud.contacts : args.displayedContacts}
        addableContacts={isCloud ? [] : args.addableContacts}
        contactRequestCount={isCloud
          ? cloud.requests.filter(isPendingIncomingCloudContactRequest).length
          : (args.contactRequests?.length ?? 0)}
        setActiveContactGroup={args.setActiveContactGroup}
        setActiveContactId={args.setActiveContactId}
        displayedAgents={args.displayedAgents}
        activeBridgeHost={args.activeBridgeHost}
        localProfileAvatarSeed={args.localProfileAvatarSeed}
        cloudAccount={isCloud ? cloudSession.account : null}
        onUpdateCloudProfile={isCloud ? async (input) => { await cloudSession.updateProfile(input); } : undefined}
        onCloudSignOut={isCloud ? async () => { await cloudSession.signOut(); } : undefined}
        isBridgePolling={args.isBridgePolling}
        onRefreshBridge={() => {
          void args.refreshDesktopBridge();
        }}
        onCopyBridgeHostUrl={() => {
          if (args.activeBridgeHost) {
            void args.handleCopyBridgeText(args.activeBridgeHost.serverUrl, 'Bridge host URL copied');
          }
        }}
        onCreateBridgeDraft={args.handleCreateBridgeDraft}
      />
  );
}
