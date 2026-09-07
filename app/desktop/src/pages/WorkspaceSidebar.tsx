import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Archive, ChevronLeft } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ChatCreateDialog } from '@/pages/ChatCreateDialog';
import type {
  ChatCreateMode,
  ChatCreatePopoverAnchor,
} from '@/pages/ChatCreateDialog';
import { GroupDetailsDialog } from '@/pages/GroupDetailsDialog';
import type { GroupManagementPopoverAnchor } from '@/pages/GroupDetailsDialog';
import {
  DeleteSessionDialog,
  GroupContextMenu,
  ProjectCreateDialog,
  RenameSessionDialog,
  SessionContextMenu,
} from '@/pages/SessionActionOverlays';
import type {
  SessionActionTarget,
  GroupContextMenuTarget,
  SessionContextMenuTarget,
} from '@/pages/SessionActionOverlays';
import { WorkspaceChatLists } from '@/pages/workspaceSidebar.chatLists';
import { useWorkspaceChatSidebarModel } from '@/pages/workspaceSidebar.chatModel';
import { ChatSidebarChrome } from '@/pages/workspaceSidebar.chrome';
import { WorkspaceNavigationRail } from '@/pages/workspaceSidebar.navigation';
import {
  SidebarAgentsPanel,
  SidebarContactsPanel,
  SidebarProjectsPanel,
  SidebarSettingsPanel,
} from '@/pages/workspaceSidebar.panels';
import type { WorkspaceSidebarProps } from '@/pages/workspaceSidebar.types';

export type { WorkspaceSidebarProps } from '@/pages/workspaceSidebar.types';
export { desktopUpdateButtonPresentation } from '@/pages/workspaceSidebar.updatePresentation';
export {
  CloudProfileLogoutAction,
  CloudProfileRowCopyButton,
} from '@/pages/workspaceSidebar.profile';
export { buildCloudProfileRows } from '@/pages/workspaceSidebar.profileModel';
export { SidebarSessionStatusIndicator } from '@/pages/workspaceSidebar.shared';
export {
  participantSpaceCanRenameSessions,
  participantSpaceSessionIdLabel,
  participantSpaceSessionRowTitle,
  sessionContextMenuTargetForConversation,
} from '@/pages/workspaceSidebar.chatHelpers';

function browserHasNetworkAccess() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function useBrowserOnlineStatus() {
  const [isOnline, setIsOnline] = useState(browserHasNetworkAccess);

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(browserHasNetworkAccess());
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  return isOnline;
}

export function WorkspaceSidebar({
  layout,
  chats,
  projects,
  directory,
  account,
}: WorkspaceSidebarProps) {
  const {
    isNativeShell,
    isSingleWorkspacePage,
    collapseChatSessions,
    showSessionRail,
    sessionRailWidth,
    activeNav,
    setActiveNav,
    onCheckForUpdates,
    onInstallUpdate,
    onRetryUpdate,
    onSubscribeToUpdate,
    onOpenUpdateUrl,
  } = layout;
  const {
    chatSearch,
    setChatSearch,
    desktopChatError,
    activeConvId,
    onPrefetchChatSession,
    onSelectChatSession,
    onStartChatWithPerson,
    onStartChatWithAgent,
    onCreateChatGroup,
    onAddContactByNodeId,
    onLookupContact,
    addContactPlaceholder,
    onCreateChatSessionInParticipantSpace,
    onRenameChatGroup,
    onRenameChatSession,
    onAddChatGroupMembers,
    onRemoveChatGroupMember,
    onSetChatGroupAdmin,
    onArchiveChatSession,
    onRestoreChatSession,
    onSetChatSessionPinned,
    onSetChatSessionMuted,
    onSetChatSessionUnread,
    onMarkChatSessionsRead,
    onSetChatGroupPinned,
    onSetChatGroupMuted,
    onSetChatGroupArchived,
    onDeleteChatSession,
  } = chats;
  const {
    onCreateProjectFromFolder,
    onCreateProject,
  } = projects;
  const {
    displayedContacts,
    addableContacts,
    contactRequestCount,
    displayedAgents,
  } = directory;
  const {
    cloudAccount,
    onCreateGroupInvite,
    onListGroupInvites,
    onRevokeGroupInvite,
  } = account;
  const isBrowserOnline = useBrowserOnlineStatus();
  const chatModel = useWorkspaceChatSidebarModel(chats, {
    isCollaborationSyncUnavailable:
      chats.isCollaborationSyncUnavailable === true || !isBrowserOnline,
  });
  const {
    agentUnread,
    chatChannel,
    collaborationSyncAriaLabel,
    collaborationSyncStatus,
    contactUnread,
    setChatChannel,
  } = chatModel;
  const pendingContactRequestCount = Math.max(0, contactRequestCount);

  const [sessionContextMenu, setSessionContextMenu] =
    useState<SessionContextMenuTarget | null>(null);
  const [groupContextMenu, setGroupContextMenu] =
    useState<GroupContextMenuTarget | null>(null);
  const [removeSessionTarget, setRemoveSessionTarget] =
    useState<SessionActionTarget | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] =
    useState<SessionActionTarget | null>(null);
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] =
    useState(false);
  const [isChatCreateDialogOpen, setIsChatCreateDialogOpen] = useState(false);
  const [chatCreateInitialMode, setChatCreateInitialMode] =
    useState<ChatCreateMode>('menu');
  const [chatCreateAnchor, setChatCreateAnchor] =
    useState<ChatCreatePopoverAnchor | null>(null);
  const [isGroupDetailsDialogOpen, setIsGroupDetailsDialogOpen] =
    useState(false);
  const [groupDetailsAnchor, setGroupDetailsAnchor] =
    useState<GroupManagementPopoverAnchor | null>(null);

  const openChatCreateDialog = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActiveNav('chats');
    setChatCreateInitialMode('menu');
    setChatCreateAnchor({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    setIsChatCreateDialogOpen(true);
  }, [setActiveNav]);

  useEffect(() => {
    if (!sessionContextMenu && !groupContextMenu) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSessionContextMenu(null);
        setGroupContextMenu(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [groupContextMenu, sessionContextMenu]);

  const closeSessionDialogs = () => {
    setRemoveSessionTarget(null);
    setRenameSessionTarget(null);
  };

  const openAgentCreate = () => {
    setChatCreateInitialMode('agent');
    setChatCreateAnchor(null);
    setIsChatCreateDialogOpen(true);
  };

  const chatSidebarChrome = useMemo(() => (
    <ChatSidebarChrome
      agentUnread={agentUnread}
      chatChannel={chatChannel}
      chatSearch={chatSearch}
      collaborationSyncAriaLabel={collaborationSyncAriaLabel}
      collaborationSyncStatus={collaborationSyncStatus}
      contactUnread={contactUnread}
      onOpenCreate={openChatCreateDialog}
      setChatChannel={setChatChannel}
      setChatSearch={setChatSearch}
    />
  ), [
    agentUnread,
    chatChannel,
    collaborationSyncAriaLabel,
    collaborationSyncStatus,
    contactUnread,
    chatSearch,
    openChatCreateDialog,
    setChatChannel,
    setChatSearch,
  ]);

  return (
    <>
      <aside
        className={cn(
          'app-side-shell app-workspace-sidebar overflow-hidden',
          isSingleWorkspacePage
            ? 'rounded-none'
            : 'rounded-bl-[22px] rounded-r-none',
        )}
      >
        <div className="flex h-full">
          <WorkspaceNavigationRail
            isNativeShell={isNativeShell}
            activeNav={activeNav}
            setActiveNav={setActiveNav}
            totalUnread={chatModel.totalUnread}
            pendingContactRequestCount={pendingContactRequestCount}
            account={account}
            updater={{
              onCheckForUpdates,
              onInstallUpdate,
              onRetryUpdate,
              onSubscribeToUpdate,
              onOpenUpdateUrl,
            }}
          />

          {showSessionRail && !collapseChatSessions ? (
            <div
              className={cn(
                'app-session-panel overflow-hidden',
                isNativeShell ? 'pt-9' : '',
              )}
              style={{ width: `${sessionRailWidth}px` }}
            >
              <div className="h-full overflow-hidden">
                {activeNav === 'chats' ? (
                  <div className="flex h-full flex-col p-2.5">
                    {chatSidebarChrome}

                    {chatModel.showArchived || chatModel.archivedSessionCount > 0 ? (
                      <button
                        type="button"
                        className="app-transient-flat-action mb-2 flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[11px] text-slate-300"
                        onClick={() => chatModel.setShowArchived(!chatModel.showArchived)}
                        title={chatModel.showArchived ? 'Back to chats' : 'Open archived chats'}
                        aria-label={chatModel.showArchived ? 'Back to chats' : 'Open archived chats'}
                      >
                        {chatModel.showArchived
                          ? <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                          : <Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                        <span className="flex-1">Archived chats</span>
                        {!chatModel.showArchived ? (
                          <span className="tabular-nums text-slate-500">{chatModel.archivedSessionCount}</span>
                        ) : null}
                      </button>
                    ) : null}

                    {desktopChatError ? (
                      <div className="app-error-text mb-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
                        {desktopChatError}
                      </div>
                    ) : null}

                    <WorkspaceChatLists
                      model={chatModel}
                      activeConvId={activeConvId}
                      contactActions={{
                        onPrefetchChatSession,
                        onSelectChatSession,
                        onOpenSessionContextMenu: setSessionContextMenu,
                        onOpenGroupContextMenu: setGroupContextMenu,
                        onOpenGroupDetails: (space, anchor) => {
                          chatModel.setParticipantSpaceExpanded(space.id, true);
                          setGroupDetailsAnchor(anchor);
                          setIsGroupDetailsDialogOpen(true);
                        },
                        onCreateChatSessionInParticipantSpace,
                      }}
                      onOpenAgentCreate={openAgentCreate}
                    />
                  </div>
                ) : null}

                {activeNav === 'projects' ? (
                  <SidebarProjectsPanel
                    projects={projects}
                    onOpenCreate={() => setIsCreateProjectDialogOpen(true)}
                  />
                ) : null}
                {activeNav === 'contacts' ? (
                  <SidebarContactsPanel directory={directory} />
                ) : null}
                {activeNav === 'agents' ? (
                  <SidebarAgentsPanel directory={directory} />
                ) : null}
                {activeNav === 'settings' ? <SidebarSettingsPanel /> : null}
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      {sessionContextMenu ? (
        <SessionContextMenu
          target={sessionContextMenu}
          onClose={() => setSessionContextMenu(null)}
          onRename={setRenameSessionTarget}
          onArchive={(sessionId) => { void onArchiveChatSession(sessionId); }}
          onRestore={(sessionId) => { void onRestoreChatSession(sessionId); }}
          onSetPinned={(sessionId, pinned) => { void onSetChatSessionPinned(sessionId, pinned); }}
          onSetMuted={(sessionId, muted) => { void onSetChatSessionMuted(sessionId, muted); }}
          onSetUnread={(sessionId, unread) => { void onSetChatSessionUnread(sessionId, unread); }}
          onDelete={setRemoveSessionTarget}
        />
      ) : null}
      {groupContextMenu ? (
        <GroupContextMenu
          target={groupContextMenu}
          onClose={() => setGroupContextMenu(null)}
          onSetPinned={(groupSpaceId, pinned) => { void onSetChatGroupPinned(groupSpaceId, pinned); }}
          onSetMuted={(groupSpaceId, sessionIds, muted) => {
            void onSetChatGroupMuted(groupSpaceId, sessionIds, muted);
          }}
          onMarkRead={(sessionIds) => { void onMarkChatSessionsRead(sessionIds); }}
          onArchive={(groupSpaceId, sessionIds) => {
            void onSetChatGroupArchived(groupSpaceId, sessionIds, true);
          }}
          onRestore={(groupSpaceId, sessionIds) => {
            void onSetChatGroupArchived(groupSpaceId, sessionIds, false);
          }}
        />
      ) : null}
      {renameSessionTarget ? (
        <RenameSessionDialog
          target={renameSessionTarget}
          onCancel={closeSessionDialogs}
          onConfirm={onRenameChatSession}
        />
      ) : null}
      {removeSessionTarget ? (
        <DeleteSessionDialog
          target={removeSessionTarget}
          onCancel={closeSessionDialogs}
          onConfirm={onDeleteChatSession}
        />
      ) : null}
      <ChatCreateDialog
        key={isChatCreateDialogOpen ? chatCreateInitialMode : 'closed'}
        isOpen={isChatCreateDialogOpen}
        contacts={displayedContacts}
        addableContacts={addableContacts}
        agents={displayedAgents}
        onClose={() => {
          setIsChatCreateDialogOpen(false);
          setChatCreateAnchor(null);
        }}
        onStartPerson={onStartChatWithPerson}
        onStartAgent={onStartChatWithAgent}
        onCreateGroup={onCreateChatGroup}
        onAddContact={onAddContactByNodeId}
        onLookupContact={onLookupContact}
        addContactPlaceholder={addContactPlaceholder}
        initialMode={chatCreateInitialMode}
        anchorRect={chatCreateAnchor}
      />

      <GroupDetailsDialog
        isOpen={isGroupDetailsDialogOpen}
        space={chatModel.selectedParticipantSpace}
        contacts={displayedContacts}
        currentAccountId={cloudAccount?.accountId}
        onClose={() => {
          setIsGroupDetailsDialogOpen(false);
          setGroupDetailsAnchor(null);
        }}
        onRename={onRenameChatGroup}
        onAddMembers={onAddChatGroupMembers}
        onRemoveMember={onRemoveChatGroupMember}
        onSetAdmin={onSetChatGroupAdmin}
        onAddContact={onAddContactByNodeId}
        onCreateGroupInvitation={onCreateGroupInvite}
        onListGroupInvitations={onListGroupInvites}
        onRevokeGroupInvitation={onRevokeGroupInvite}
        onMessageContact={async (contact) => {
          setIsGroupDetailsDialogOpen(false);
          setGroupDetailsAnchor(null);
          await onStartChatWithPerson(contact);
        }}
        anchorRect={groupDetailsAnchor}
      />

      {isCreateProjectDialogOpen ? (
        <ProjectCreateDialog
          onCancel={() => setIsCreateProjectDialogOpen(false)}
          onCreateFromFolder={onCreateProjectFromFolder}
          onCreateNew={onCreateProject}
        />
      ) : null}
    </>
  );
}
