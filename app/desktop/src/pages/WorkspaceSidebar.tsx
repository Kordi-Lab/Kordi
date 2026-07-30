import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  ChevronDown,
  MoreHorizontal,
  Plus,
  Search,
} from 'lucide-react';

import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { conversationChatKindLabel } from '@/features/chat/sessionKindLabels';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import { isBlankParticipantSpaceSession, primaryAgentForConversation } from '@/features/chat/participantSpaces';
import type { ChatChannel, Conversation } from '@/kordi-app/types';
import { buildForkLineage, isGroupForkSession } from '@/features/chat/forkLineage';
import { ChevronRight as ChevronRightIcon, Split } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DeleteSessionDialog,
  MoveSessionDialog,
  ProjectCreateDialog,
  RenameSessionDialog,
  SessionContextMenu,
  type SessionActionTarget,
  type SessionContextMenuTarget,
} from '@/pages/SessionActionOverlays';
import { ChatCreateDialog } from '@/pages/ChatCreateDialog';
import type { ChatCreateMode, ChatCreatePopoverAnchor } from '@/pages/ChatCreateDialog';
import { GroupDetailsDialog } from '@/pages/GroupDetailsDialog';
import type { GroupManagementPopoverAnchor } from '@/pages/GroupDetailsDialog';
import {
  buildChatSidebarRows,
  VirtualChatList,
  type ChatSidebarRow,
  type ChatSidebarSessionInput,
} from '@/pages/sidebar/VirtualChatList';
import type {
  WorkspaceSidebarConversation as ConversationItem,
  WorkspaceSidebarParticipantSpace as ParticipantSpaceItem,
  WorkspaceSidebarProject as ProjectItem,
  WorkspaceSidebarProps,
} from '@/pages/workspaceSidebar.types';
import { SidebarUpdater } from '@/pages/workspaceSidebar.update';
import { SidebarProfileControl } from '@/pages/workspaceSidebar.profile';
import {
  SidebarAgentsPanel,
  SidebarContactsPanel,
  SidebarProjectsPanel,
  SidebarSettingsPanel,
} from '@/pages/workspaceSidebar.panels';
import {
  SidebarSessionMetaColumn,
  SidebarUnreadBadge,
} from '@/pages/workspaceSidebar.shared';

export type { WorkspaceSidebarProps } from '@/pages/workspaceSidebar.types';
export { desktopUpdateButtonPresentation } from '@/pages/workspaceSidebar.updatePresentation';
export {
  CloudProfileLogoutAction,
  CloudProfileRowCopyButton,
} from '@/pages/workspaceSidebar.profile';
export { buildCloudProfileRows } from '@/pages/workspaceSidebar.profileModel';
export { SidebarSessionStatusIndicator } from '@/pages/workspaceSidebar.shared';

function filterGroupForkSessionsFromSpaces(spaces: ParticipantSpaceItem[]): ParticipantSpaceItem[] {
  return spaces
    .map((space) => ({
      ...space,
      sessions: space.sessions.filter((session) => !isGroupForkSession(session)),
    }))
    .filter((space) => space.sessions.length > 0);
}

const LEGACY_CANONICAL_COLLABORATION_SESSION_PREFIX = 'session:bridge:';
const LOCAL_RUNTIME_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function participantSpaceSessionRowTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return '# Untitled session';
  return trimmed.startsWith('#') ? trimmed : `# ${trimmed}`;
}

export function participantSpaceSessionIdLabel(session: {
  id?: string | null;
  canonicalSessionId?: string | null;
  conversation?: Partial<Pick<Conversation, 'id' | 'canonicalSessionId' | 'type' | 'directness'>>;
}) {
  const sessionId = (session.id || session.canonicalSessionId || '').trim();
  if (!sessionId || sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) return '';
  if (session.conversation) {
    return conversationChatKindLabel({
      ...session.conversation,
      id: session.id ?? session.conversation.id,
      canonicalSessionId: session.canonicalSessionId ?? session.conversation.canonicalSessionId,
    });
  }
  return formatSessionIdSubtitle(sessionId);
}

function participantSpaceSessionPreviewText(preview: string) {
  const formatted = formatSessionIdSubtitle(preview);
  if (/^session id:/i.test(formatted)) return '';
  return formatted;
}

function participantSpaceSessionMessageCount(session: ParticipantSpaceItem['sessions'][number]) {
  const canonicalCount = session.conversation.canonicalMessageCount;
  if (typeof canonicalCount === 'number' && Number.isFinite(canonicalCount)) {
    return Math.max(0, canonicalCount);
  }
  const visibleMessages = session.conversation.messages
    .filter((message) => message.role !== 'system' && message.text.trim().length > 0)
    .length;
  return visibleMessages + (session.conversation.queuedMessages?.length ?? 0);
}

function participantSpaceSessionMessageCountText(messageCount: number) {
  return `${messageCount} message${messageCount === 1 ? '' : 's'}`;
}

function participantSpaceSessionPreviewLine(preview: string, messageCount: number) {
  const text = preview.trim() || 'No messages yet';
  return `${text} · ${participantSpaceSessionMessageCountText(messageCount)}`;
}

function sessionActionIdForConversation(conversation: ConversationItem) {
  const sessionId = (conversation.canonicalSessionId || conversation.id).trim();
  if (!sessionId || sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) return null;
  if (sessionId.startsWith('bridge:')) return null;
  return sessionId;
}

function canMoveConversationToProject(conversation: ConversationItem, sessionId: string) {
  return conversation.type === 'owned-agent'
    && sessionId === conversation.id.trim()
    && LOCAL_RUNTIME_SESSION_ID_PATTERN.test(sessionId)
    && !sessionId.startsWith(LEGACY_CANONICAL_COLLABORATION_SESSION_PREFIX);
}

export function sessionContextMenuTargetForConversation(
  conversation: ConversationItem,
  x: number,
  y: number,
  options: { canRename?: boolean } = {},
): SessionContextMenuTarget | null {
  const sessionId = sessionActionIdForConversation(conversation);
  if (!sessionId) return null;

  return {
    sessionId,
    sessionName: conversation.name,
    x,
    y,
    canMoveToProject: canMoveConversationToProject(conversation, sessionId),
    ...(options.canRename === false ? { canRename: false } : {}),
  };
}

export function participantSpaceCanRenameSessions(space: ParticipantSpaceItem) {
  if (space.kind !== 'group') return true;
  const selfIdentityIds = new Set(space.participants
    .filter((participant) => participant.role === 'self' || participant.source === 'local')
    .map((participant) => participant.id.trim())
    .filter(Boolean));
  if (selfIdentityIds.size === 0) return false;
  const adminIdentityIds = new Set((space.groupAdminIdentityIds ?? [])
    .map((identityId) => identityId.trim())
    .filter(Boolean));
  return [...selfIdentityIds].some((identityId) => adminIdentityIds.has(identityId));
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function participantSpaceHumanCount(space: ParticipantSpaceItem) {
  return space.participants.filter((participant) => participant.kind === 'human').length;
}

function participantSpaceKindText(space: ParticipantSpaceItem) {
  if (space.kind === 'self') return 'Personal';
  if (space.kind === 'direct-human') return 'Person';
  if (space.kind === 'direct-agent') return 'Agent';
  return 'Group';
}

function participantSpaceDetailText(space: ParticipantSpaceItem) {
  const sessionText = pluralize(space.sessionCount, 'session');
  if (space.kind === 'self') {
    return `Personal • ${sessionText}`;
  }
  if (space.kind === 'direct-human') {
    return null;
  }
  if (space.kind === 'group') {
    const humanCount = participantSpaceHumanCount(space);
    const peopleText = humanCount > 0 ? `${pluralize(humanCount, 'person', 'people')} • ` : '';
    return `Group • ${peopleText}${sessionText}`;
  }
  return `Agent • ${sessionText}`;
}

function ParticipantSpaceAvatarStack({ space }: { space: ParticipantSpaceItem }) {
  const avatars = space.avatarStack.length > 0
    ? space.avatarStack
    : [{ kind: space.kind === 'direct-agent' ? 'agent' as const : 'human' as const, seed: space.id, imageUrl: null }];
  const showPresenceLight = space.kind !== 'group';

  if (avatars.length === 1) {
    const avatar = avatars[0];
    return (
      <div className="relative h-9 w-9 shrink-0">
        <IdentityAvatar
          kind={avatar.kind}
          seed={avatar.seed}
          name={space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-9 w-9"
          presenceStatus={showPresenceLight ? avatar.presenceStatus : null}
          presenceLabel={showPresenceLight && avatar.presenceStatus ? `${space.title} is ${avatar.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
        />
      </div>
    );
  }

  return (
    <div className="flex h-9 w-10 shrink-0 items-center -space-x-5" aria-hidden="true">
      {avatars.slice(0, 3).map((avatar, index) => (
        <span key={`${avatar.seed}-${index}`} className="relative inline-flex" style={{ zIndex: avatars.length - index }}>
          <IdentityAvatar
            kind={avatar.kind}
            seed={avatar.seed}
            name={space.title}
            imageUrl={avatar.imageUrl ?? undefined}
            className="h-7 w-7"
            presenceStatus={showPresenceLight ? avatar.presenceStatus : null}
            presenceLabel={showPresenceLight && avatar.presenceStatus ? `${space.title} member is ${avatar.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
          />
        </span>
      ))}
    </div>
  );
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
    chatConversations,
    onCreateChatSession,
    chatSearch,
    setChatSearch,
    desktopChatError,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    initialSelectedParticipantSpaceId = null,
    initialChatChannel = 'contact',
    activeConvId,
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
    onDeleteChatSession,
    onMoveChatSessionToProject,
    isCollaborationSyncing,
  } = chats;
  const {
    onCreateProjectFromFolder,
    onCreateProject,
    runtimeProjects,
  } = projects;
  const {
    displayedContacts,
    addableContacts,
    contactRequestCount,
    displayedAgents,
  } = directory;
  const { cloudAccount } = account;
  const totalUnread = chatConversations.reduce((sum, conversation) => (
    isGroupForkSession(conversation) ? sum : sum + Math.max(0, conversation.unread ?? 0)
  ), 0);
  const pendingContactRequestCount = Math.max(0, contactRequestCount);
  const formatUnreadCount = (value: number) => (value > 99 ? '99+' : `${value}`);
  const collaborationSyncStatus = isCollaborationSyncing ? 'syncing' : 'idle';
  const chatStatusLabel = isCollaborationSyncing
    ? 'syncing…'
    : totalUnread > 0
      ? `${formatUnreadCount(totalUnread)} unread`
      : 'all caught up';
  const collaborationSyncAriaLabel = isCollaborationSyncing
    ? 'Messages are syncing'
    : totalUnread > 0
      ? `Messages idle, ${formatUnreadCount(totalUnread)} unread`
      : 'Messages idle, all caught up';
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuTarget | null>(null);
  const [removeSessionTarget, setRemoveSessionTarget] = useState<SessionActionTarget | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<SessionActionTarget | null>(null);
  const [moveSessionTarget, setMoveSessionTarget] = useState<SessionActionTarget | null>(null);
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
  const [isChatCreateDialogOpen, setIsChatCreateDialogOpen] = useState(false);
  const [chatCreateInitialMode, setChatCreateInitialMode] = useState<ChatCreateMode>('menu');
  const [chatCreateAnchor, setChatCreateAnchor] = useState<ChatCreatePopoverAnchor | null>(null);
  const [isGroupDetailsDialogOpen, setIsGroupDetailsDialogOpen] = useState(false);
  const [groupDetailsAnchor, setGroupDetailsAnchor] = useState<GroupManagementPopoverAnchor | null>(null);
  const [selectedParticipantSpaceId, setSelectedParticipantSpaceId] = useState<string | null>(initialSelectedParticipantSpaceId);
  const [chatChannel, setChatChannel] = useState<ChatChannel>(initialChatChannel);
  const visibleParticipantSpaces = useMemo(() => filterGroupForkSessionsFromSpaces(participantSpaces), [participantSpaces]);
  const visibleContactParticipantSpaces = useMemo(() => filterGroupForkSessionsFromSpaces(contactParticipantSpaces), [contactParticipantSpaces]);
  const visibleAgentParticipantSpaces = useMemo(() => filterGroupForkSessionsFromSpaces(agentParticipantSpaces), [agentParticipantSpaces]);


  const activeParticipantSpaceId = visibleParticipantSpaces.find((space) => (
    space.sessions.some((session) => session.id === activeConvId || session.canonicalSessionId === activeConvId)
  ))?.id ?? null;
  const selectedParticipantSpace = selectedParticipantSpaceId
    ? visibleParticipantSpaces.find((space) => space.id === selectedParticipantSpaceId) ?? null
    : null;
  const openChatCreateDialog = (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActiveNav('chats');
    setChatCreateInitialMode('menu');
    setChatCreateAnchor({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    setIsChatCreateDialogOpen(true);
  };

  useEffect(() => {
    if (!sessionContextMenu) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSessionContextMenu(null);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [sessionContextMenu]);

  useEffect(() => {
    if (selectedParticipantSpaceId && !visibleParticipantSpaces.some((space) => space.id === selectedParticipantSpaceId)) {
      setSelectedParticipantSpaceId(null);
    }
  }, [visibleParticipantSpaces, selectedParticipantSpaceId]);

  const closeSessionDialogs = () => {
    setRemoveSessionTarget(null);
    setMoveSessionTarget(null);
    setRenameSessionTarget(null);
  };

  // Session hierarchy is flattened before rendering; this component owns only
  // one measured row so offscreen fork descendants never mount recursively.
  const renderParticipantSpaceSessionRow = (
    session: ParticipantSpaceItem['sessions'][number],
    space: ParticipantSpaceItem,
    depth: number,
  ) => {
    const conversation = session.conversation;
    const isActive = activeConvId === session.id || activeConvId === session.canonicalSessionId;
    const sessionRowTimeLabel = session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
    const sessionPreview = participantSpaceSessionPreviewText(session.preview) || 'No messages yet';
    const sessionRowTitle = participantSpaceSessionRowTitle(session.title);
    const sessionMessageCount = participantSpaceSessionMessageCount(session);
    const sessionPreviewLine = participantSpaceSessionPreviewLine(sessionPreview, sessionMessageCount);
    const sessionIdLabel = participantSpaceSessionIdLabel(session);
    const isFork = depth > 0;
    const childForks = globalForkLineage.forksByParentSessionId.get(session.id) ?? [];
    const hasForks = childForks.length > 0;
    const expanded = hasForks && isForkListExpanded(session.id);
    const ownSessionUnreadCount = sidebarSessionIsActive(session) ? 0 : session.unread;
    const rowUnreadCount = expanded
      ? ownSessionUnreadCount
      : (unreadBySessionIdWithForkDescendants.get(session.id) ?? ownSessionUnreadCount);
    const visualDepth = Math.min(depth, 4);
    const indentPaddingLeft = visualDepth > 0 ? `${0.625 + visualDepth * 0.875}rem` : undefined;
    return (
      <button
          type="button"
          data-testid="participant-space-session-row"
          data-agent-session-row={session.id}
          data-session-preview={sessionPreview}
          data-session-preview-line={sessionPreviewLine}
          data-session-id-label={sessionIdLabel}
          data-session-message-count={sessionMessageCount}
          data-session-updated-at={sessionRowTimeLabel}
          data-session-fork-depth={visualDepth || undefined}
          onClick={() => onSelectChatSession(session.id)}
          onContextMenu={(event) => {
            const target = sessionContextMenuTargetForConversation(
              conversation,
              event.clientX,
              event.clientY,
              { canRename: participantSpaceCanRenameSessions(space) },
            );
            if (!target) return;
            event.preventDefault();
            event.stopPropagation();
            setSessionContextMenu(target);
          }}
          style={indentPaddingLeft ? { paddingLeft: indentPaddingLeft } : undefined}
          className={cn(
            'app-session-row app-participant-space-session-row w-full px-2.5 py-1 text-left text-white',
            isActive && 'app-session-row-active',
            isFork && 'app-session-row-fork',
          )}
        >
          <div className="app-participant-space-session-main min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="app-session-row-title app-participant-space-session-title min-w-0 flex-1 truncate text-[12px] font-medium">{sessionRowTitle}</span>
            </div>
            <div
              className={cn(
                'app-participant-space-session-preview mt-px truncate text-[10.5px] leading-[1.05rem]',
                isActive ? 'text-slate-300' : 'text-slate-500',
                session.statusIndicator?.live && 'app-participant-space-session-preview-live',
              )}
            >
              {sessionPreviewLine}
            </div>
          </div>
          <div className="app-participant-space-session-side">
            <SidebarSessionMetaColumn
              timeLabel={sessionRowTimeLabel}
              unreadCount={rowUnreadCount}
              unreadScope="participant-session"
              indicator={session.statusIndicator}
              active={isActive}
            />
            {hasForks ? (
              <>
                <span
                  className="app-participant-space-session-fork-count inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.06] px-1.5 text-[9.5px] font-medium tabular-nums text-slate-300"
                  title={`${childForks.length} fork${childForks.length === 1 ? '' : 's'} of this session`}
                  aria-label={`${childForks.length} forks`}
                >
                  <Split className="h-2.5 w-2.5" />
                  <span>{childForks.length}</span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleForkParent(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    toggleForkParent(session.id);
                  }}
                  className="app-participant-space-session-fork-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-100"
                  aria-label={expanded ? 'Hide forks' : 'Show forks'}
                  title={expanded ? 'Hide forks' : 'Show forks'}
                >
                  <ChevronRightIcon
                    className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')}
                  />
                </span>
              </>
            ) : isFork ? (
              <span
                className="app-participant-space-session-fork-marker inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
                aria-hidden="true"
                title="Forked session"
              >
                <Split className="h-3 w-3" />
              </span>
            ) : null}
          </div>
      </button>
    );
  };

  const renderParticipantSpaceItem = (space: ParticipantSpaceItem) => {
    const latestSession = space.sessions[0];
    const isDirectHuman = space.kind === 'direct-human';
    const hasBlankSession = space.sessions.some(isBlankParticipantSpaceSession);
    const isActiveSpace = activeParticipantSpaceId === space.id;
    const isPrimarySessionActive = Boolean(latestSession && (
      activeConvId === latestSession.id || activeConvId === latestSession.canonicalSessionId
    ));
    const isSelectedSpace = !isDirectHuman && selectedParticipantSpaceId === space.id;
    const isExpanded = !isDirectHuman && (isSelectedSpace || isActiveSpace);
    const isAutoExpanded = isExpanded && isActiveSpace && !isSelectedSpace;
    const rowTimeLabel = space.updatedAtLabel ?? latestSession?.updatedAtLabel ?? '--:--';
    const spaceUnreadCount = unreadByParticipantSpaceIdWithForkDescendants.get(space.id) ?? space.unread;
    const participantSpaceDetail = participantSpaceDetailText(space);
    const selectParticipantSpacePrimarySession = (space: ParticipantSpaceItem) => {
      const latestSession = space.sessions[0];
      if (!latestSession) return;
      if (!isDirectHuman) setSelectedParticipantSpaceId(space.id);
      onSelectChatSession(latestSession.id);
    };
    const toggleSpace = () => {
      if (isDirectHuman) return;
      setSelectedParticipantSpaceId((current) => current === space.id ? null : space.id);
    };
    return (
      <div
        key={space.id}
        className={cn('app-participant-space-inline-group', isExpanded && 'app-participant-space-inline-group-expanded')}
        data-participant-space-auto-expanded={isAutoExpanded ? 'true' : undefined}
      >
        <div
          className={cn(
            'app-participant-space-row-shell',
            isExpanded && 'app-participant-space-row-shell-expanded',
            isDirectHuman && isPrimarySessionActive && 'app-session-row-active app-participant-space-row-shell-selected',
          )}
          data-participant-space-row-shell="true"
        >
          <button
            type="button"
            data-testid="participant-space-row"
            data-participant-space-toggle={isDirectHuman ? undefined : 'true'}
            aria-expanded={isDirectHuman ? undefined : isExpanded}
            onClick={() => selectParticipantSpacePrimarySession(space)}
            className="app-session-row app-participant-space-row-button w-full min-w-0 text-left text-white"
          >
            <ParticipantSpaceAvatarStack space={space} />
            <div className="min-w-0">
              <div className="app-participant-space-row-title truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={space.title}>{space.title}</div>
              <div className={cn('app-participant-space-row-preview mt-px truncate text-[10.5px] leading-[0.98rem]', (isExpanded || (isDirectHuman && isPrimarySessionActive)) && 'app-participant-space-row-preview-active')}>
                {space.preview || `${participantSpaceKindText(space)} space`}
              </div>
              {participantSpaceDetail ? (
                <div className="app-participant-space-row-detail mt-px truncate text-[10px] leading-[0.88rem]">
                  {participantSpaceDetail}
                </div>
              ) : null}
            </div>
          </button>
          <div className="app-participant-space-row-side">
            {!isDirectHuman ? (
              <div className="app-participant-space-row-actions" data-participant-space-row-actions="true">
                {space.kind === 'group' ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedParticipantSpaceId(space.id);
                      const rect = event.currentTarget.getBoundingClientRect();
                      setGroupDetailsAnchor({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
                      setIsGroupDetailsDialogOpen(true);
                    }}
                    className="app-participant-space-action app-participant-space-menu-action grid h-6 w-6 shrink-0 place-items-center rounded-[8px]"
                    title="Group management"
                    aria-label="Open group management"
                    aria-haspopup="dialog"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span className="app-participant-space-action-spacer h-6 w-6" aria-hidden="true" />
                )}
                <button
                  type="button"
                  data-participant-space-context-create="true"
                  data-disabled-reason={hasBlankSession ? 'blank-session' : undefined}
                  disabled={hasBlankSession}
                  className="app-participant-space-action app-participant-space-context-create grid h-6 w-6 place-items-center rounded-[8px] transition"
                  aria-label={hasBlankSession
                    ? `New session unavailable in ${space.title}: a blank chat already exists`
                    : `Create session in ${space.title}`}
                  title={hasBlankSession
                    ? 'Send a message in the blank chat before creating another session'
                    : `Create session in ${space.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedParticipantSpaceId(space.id);
                    void onCreateChatSessionInParticipantSpace(space);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-participant-space-toggle-button="true"
                  className="app-participant-space-action app-participant-space-enter-action grid h-6 w-6 place-items-center rounded-[8px]"
                  title={isSelectedSpace ? 'Collapse sessions' : 'Expand sessions'}
                  aria-label={`${isSelectedSpace ? 'Collapse' : 'Expand'} ${space.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSpace();
                  }}
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition', isSelectedSpace ? 'rotate-180' : '')} />
                </button>
              </div>
            ) : null}
            <div className="app-participant-space-row-meta">
              <SidebarSessionMetaColumn
                timeLabel={rowTimeLabel}
                unreadCount={isExpanded ? 0 : spaceUnreadCount}
                unreadScope="participant-space"
                indicator={isExpanded ? undefined : latestSession?.statusIndicator}
                active={isDirectHuman && isPrimarySessionActive}
                reserveStatusSpace={false}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Build a sidebar-wide fork lineage that spans every visible space.
  // Group-derived forks have already been filtered out; remaining forks can
  // still nest under their parent regardless of which tab owns the row.
  const allSidebarSessions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem }> = [];
    for (const space of [...visibleAgentParticipantSpaces, ...visibleContactParticipantSpaces, ...visibleParticipantSpaces]) {
      for (const session of space.sessions) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        out.push({ session, space });
      }
    }
    return out;
  }, [visibleAgentParticipantSpaces, visibleContactParticipantSpaces, visibleParticipantSpaces]);
  const globalForkLineage = useMemo(
    () => buildForkLineage(allSidebarSessions.map(({ session }) => session)),
    [allSidebarSessions],
  );
  const allSidebarSessionRowsById = useMemo(
    () => new Map(allSidebarSessions.map((row) => [row.session.id, row])),
    [allSidebarSessions],
  );
  const activeSidebarSessionId = (activeConvId || '').trim();
  const sidebarSessionIsActive = useCallback((session?: ParticipantSpaceItem['sessions'][number]) => Boolean(
    session
      && activeSidebarSessionId
      && (activeSidebarSessionId === session.id || activeSidebarSessionId === session.canonicalSessionId),
  ), [activeSidebarSessionId]);
  const unreadBySessionIdWithForkDescendants = useMemo(() => {
    const cache = new Map<string, number>();
    const visit = (sessionId: string, seen: Set<string>): number => {
      if (cache.has(sessionId)) return cache.get(sessionId) ?? 0;
      if (seen.has(sessionId)) return 0;
      const nextSeen = new Set(seen);
      nextSeen.add(sessionId);
      const rowSession = allSidebarSessionRowsById.get(sessionId)?.session;
      const ownUnread = sidebarSessionIsActive(rowSession) ? 0 : Math.max(0, rowSession?.unread ?? 0);
      const forkUnread = (globalForkLineage.forksByParentSessionId.get(sessionId) ?? [])
        .reduce((sum, fork) => sum + visit(fork.id, nextSeen), 0);
      const total = ownUnread + forkUnread;
      cache.set(sessionId, total);
      return total;
    };
    for (const sessionId of allSidebarSessionRowsById.keys()) visit(sessionId, new Set());
    return cache;
  }, [allSidebarSessionRowsById, globalForkLineage, sidebarSessionIsActive]);
  const unreadByParticipantSpaceIdWithForkDescendants = useMemo(() => {
    const collect = (sessionId: string, target: Set<string>, seen: Set<string>) => {
      if (seen.has(sessionId)) return;
      seen.add(sessionId);
      target.add(sessionId);
      for (const fork of globalForkLineage.forksByParentSessionId.get(sessionId) ?? []) {
        collect(fork.id, target, seen);
      }
    };
    const unreadBySpaceId = new Map<string, number>();
    for (const space of visibleParticipantSpaces) {
      const sessionIds = new Set<string>();
      for (const session of space.sessions) collect(session.id, sessionIds, new Set());
      const unread = [...sessionIds].reduce((sum, sessionId) => {
        const rowSession = allSidebarSessionRowsById.get(sessionId)?.session;
        return sum + (sidebarSessionIsActive(rowSession) ? 0 : Math.max(0, rowSession?.unread ?? 0));
      }, 0);
      unreadBySpaceId.set(space.id, unread);
    }
    return unreadBySpaceId;
  }, [allSidebarSessionRowsById, globalForkLineage, visibleParticipantSpaces, sidebarSessionIsActive]);
  const contactUnread = visibleContactParticipantSpaces.reduce((sum, space) => (
    sum + Math.max(0, unreadByParticipantSpaceIdWithForkDescendants.get(space.id) ?? space.unread)
  ), 0);

  const flatAgentSessions = useMemo(() => visibleAgentParticipantSpaces
    .flatMap((space) => space.sessions.map((session) => ({ session, space })))
    .sort((left, right) => right.session.updatedAtMs - left.session.updatedAtMs
      || left.session.title.localeCompare(right.session.title)), [visibleAgentParticipantSpaces]);

  // Group remaining visible forks under their source session in the agent tab.
  // Forks whose parent is a canonical contact session are excluded here — they
  // are rendered nested under the parent in the Contact tab so they live with
  // the conversation they branched from.
  const agentForkLineage = useMemo(
    () => buildForkLineage(flatAgentSessions.map(({ session }) => session)),
    [flatAgentSessions],
  );
  const topLevelAgentSessions = useMemo(
    () => flatAgentSessions.filter(({ session }) => {
      if (agentForkLineage.forkSessionIds.has(session.id)) return false;
      const parent = session.forkedFromSessionId?.trim();
      if (parent && parent.startsWith('session:')) return false;
      return true;
    }),
    [agentForkLineage, flatAgentSessions],
  );
  const agentSessionRowsById = useMemo(
    () => new Map(flatAgentSessions.map((row) => [row.session.id, row])),
    [flatAgentSessions],
  );
  const renderableAgentSessionIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (sessionId: string) => {
      if (ids.has(sessionId)) return;
      ids.add(sessionId);
      for (const fork of agentForkLineage.forksByParentSessionId.get(sessionId) ?? []) {
        visit(fork.id);
      }
    };
    for (const { session } of topLevelAgentSessions) visit(session.id);
    return ids;
  }, [agentForkLineage, topLevelAgentSessions]);
  const agentUnread = flatAgentSessions.reduce((sum, { session }) => (
    renderableAgentSessionIds.has(session.id) ? sum + Math.max(0, session.unread) : sum
  ), 0);

  // Track which parent rows have their fork list expanded. Default to
  // expanded so the user immediately sees children; toggling collapses.
  const [collapsedForkParents, setCollapsedForkParents] = useState<Set<string>>(new Set());
  const toggleForkParent = useCallback((parentSessionId: string) => {
    setCollapsedForkParents((current) => {
      const next = new Set(current);
      if (next.has(parentSessionId)) next.delete(parentSessionId);
      else next.add(parentSessionId);
      return next;
    });
  }, []);
  const isForkListExpanded = useCallback(
    (parentSessionId: string) => !collapsedForkParents.has(parentSessionId),
    [collapsedForkParents],
  );

  const activeSidebarRowSessionId = useMemo(() => (
    allSidebarSessions.find(({ session }) => (
      activeConvId === session.id || activeConvId === session.canonicalSessionId
    ))?.session.id ?? activeConvId
  ), [activeConvId, allSidebarSessions]);
  const sidebarSessionInputs = useMemo<ChatSidebarSessionInput[]>(() => allSidebarSessions.map(({ session, space }) => ({
    sessionId: session.id,
    spaceId: space.id,
    parentSessionId: session.forkedFromSessionId,
  })), [allSidebarSessions]);
  const contactSpaceById = useMemo(
    () => new Map(visibleContactParticipantSpaces.map((space) => [space.id, space])),
    [visibleContactParticipantSpaces],
  );
  const contactSidebarRows = useMemo(() => buildChatSidebarRows({
    spaces: visibleContactParticipantSpaces.map((space) => {
      const isDirectHuman = space.kind === 'direct-human';
      const isActiveSpace = activeParticipantSpaceId === space.id;
      const isSelectedSpace = !isDirectHuman && selectedParticipantSpaceId === space.id;
      const expanded = !isDirectHuman && (isSelectedSpace || isActiveSpace);
      const rootSessionIds = (() => {
        if (!expanded) return [];
        if (isActiveSpace && !isSelectedSpace && activeSidebarRowSessionId) {
          let rootSessionId = activeSidebarRowSessionId;
          const seen = new Set<string>();
          while (!seen.has(rootSessionId)) {
            seen.add(rootSessionId);
            const parentId = allSidebarSessionRowsById.get(rootSessionId)?.session.forkedFromSessionId?.trim();
            if (!parentId || !allSidebarSessionRowsById.has(parentId)) break;
            rootSessionId = parentId;
          }
          return [rootSessionId];
        }
        return space.sessions
          .filter((session) => {
            const parentId = session.forkedFromSessionId?.trim();
            return !parentId || !allSidebarSessionRowsById.has(parentId);
          })
          .map((session) => session.id);
      })();
      return { spaceId: space.id, expanded, rootSessionIds };
    }),
    sessions: sidebarSessionInputs,
    collapsedForkParentIds: collapsedForkParents,
    activeSessionId: activeSidebarRowSessionId,
    includeSpaceRows: true,
  }), [
    activeParticipantSpaceId,
    activeSidebarRowSessionId,
    allSidebarSessionRowsById,
    collapsedForkParents,
    selectedParticipantSpaceId,
    sidebarSessionInputs,
    visibleContactParticipantSpaces,
  ]);
  const agentSidebarRows = useMemo(() => buildChatSidebarRows({
    spaces: [{
      spaceId: 'agent-sessions',
      expanded: true,
      rootSessionIds: topLevelAgentSessions.map(({ session }) => session.id),
    }],
    sessions: flatAgentSessions.map(({ session, space }) => ({
      sessionId: session.id,
      spaceId: space.id,
      parentSessionId: session.forkedFromSessionId,
    })),
    collapsedForkParentIds: collapsedForkParents,
    activeSessionId: activeSidebarRowSessionId,
    includeSpaceRows: false,
  }), [
    activeSidebarRowSessionId,
    collapsedForkParents,
    flatAgentSessions,
    topLevelAgentSessions,
  ]);

  const renderAgentSessionRow = (
    { session, space }: { session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem },
    options: {
      isFork?: boolean;
      depth?: number;
      forkCount?: number;
      expanded?: boolean;
      onToggleExpanded?: () => void;
    } = {},
  ) => {
    const conversation = session.conversation;
    const isActive = activeConvId === session.id || activeConvId === session.canonicalSessionId;
    const rowTimeLabel = session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
    const sessionPreview = participantSpaceSessionPreviewText(session.preview) || 'No messages yet';
    const sessionRowTitle = participantSpaceSessionRowTitle(session.title);
    const sessionMessageCount = participantSpaceSessionMessageCount(session);
    const sessionPreviewLine = participantSpaceSessionPreviewLine(sessionPreview, sessionMessageCount);
    const agentIdentity = primaryAgentForConversation(conversation);
    const agentName = agentIdentity?.name ?? space.title;
    const subtitleLine = agentName ? `${agentName} · ${sessionPreviewLine}` : sessionPreviewLine;
    const forkCount = options.forkCount ?? 0;
    const hasForks = forkCount > 0;
    const depth = Math.min(options.depth ?? 0, 4);
    const indentPaddingLeft = depth > 0 ? `${0.625 + depth * 0.875}rem` : undefined;
    return (
      <button
        key={session.id}
        type="button"
        data-testid="agent-session-row"
        data-agent-session-row={session.id}
        data-session-preview={sessionPreview}
        data-session-preview-line={sessionPreviewLine}
        data-session-message-count={sessionMessageCount}
        data-session-updated-at={rowTimeLabel}
        data-session-fork-of={options.isFork ? session.forkedFromSessionId ?? '' : undefined}
        data-session-fork-depth={depth || undefined}
        style={indentPaddingLeft ? { paddingLeft: indentPaddingLeft } : undefined}
        onClick={() => onSelectChatSession(session.id)}
        onContextMenu={(event) => {
          const target = sessionContextMenuTargetForConversation(conversation, event.clientX, event.clientY);
          if (!target) return;
          event.preventDefault();
          event.stopPropagation();
          setSessionContextMenu(target);
        }}
        className={cn(
          'app-session-row app-agent-session-row w-full px-2.5 py-1 text-left text-white',
          isActive && 'app-session-row-active',
          options.isFork && 'app-session-row-fork',
        )}
      >
        <div className="app-agent-session-main min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="app-session-row-title min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={sessionRowTitle}>{sessionRowTitle}</span>
          </div>
          <div
            className={cn(
              'mt-0.5 truncate text-[10.5px] leading-[1rem]',
              isActive ? 'text-slate-300' : 'text-slate-500',
              session.statusIndicator?.live && 'app-participant-space-session-preview-live',
            )}
          >
            {subtitleLine}
          </div>
        </div>
        <div className="app-agent-session-side">
          <SidebarSessionMetaColumn
            timeLabel={rowTimeLabel}
            unreadCount={session.unread}
            unreadScope="agent-session"
            indicator={session.statusIndicator}
            active={isActive}
          />
          {hasForks ? (
            <>
              <span
                className="app-agent-session-fork-count inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.06] px-1.5 text-[9.5px] font-medium tabular-nums text-slate-300"
                title={`${forkCount} fork${forkCount === 1 ? '' : 's'} of this session`}
                aria-label={`${forkCount} forks`}
              >
                <Split className="h-2.5 w-2.5" />
                <span>{forkCount}</span>
              </span>
              {options.onToggleExpanded ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    options.onToggleExpanded?.();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    options.onToggleExpanded?.();
                  }}
                  className="app-agent-session-fork-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-100"
                  aria-label={options.expanded ? 'Hide forks' : 'Show forks'}
                  title={options.expanded ? 'Hide forks' : 'Show forks'}
                >
                  <ChevronRightIcon
                    className={cn('h-3 w-3 transition-transform', options.expanded && 'rotate-90')}
                  />
                </span>
              ) : null}
            </>
          ) : options.isFork ? (
            <span
              className="app-agent-session-fork-marker inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
              aria-hidden="true"
              title="Forked session"
            >
              <Split className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  const sidebarEmptyState = (message: string) => (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">
      {message}
    </div>
  );
  const renderContactSidebarRow = (descriptor: ChatSidebarRow) => {
    if (descriptor.kind === 'space') {
      const space = contactSpaceById.get(descriptor.spaceId);
      return space ? renderParticipantSpaceItem(space) : null;
    }
    const row = allSidebarSessionRowsById.get(descriptor.sessionId);
    return row ? renderParticipantSpaceSessionRow(row.session, row.space, descriptor.depth) : null;
  };
  const renderAgentSidebarRow = (descriptor: ChatSidebarRow) => {
    if (descriptor.kind !== 'session') return null;
    const row = agentSessionRowsById.get(descriptor.sessionId);
    if (!row) return null;
    const forks = agentForkLineage.forksByParentSessionId.get(row.session.id) ?? [];
    const expanded = forks.length > 0 && isForkListExpanded(row.session.id);
    const isFork = descriptor.depth > 0;
    return (
      <div
        className={cn(
          isFork && 'app-session-fork-children mt-px ml-3 border-l border-white/[0.08] pl-2',
          isFork && descriptor.activePath && 'app-session-fork-children-active',
        )}
        data-session-fork-depth={isFork ? descriptor.depth : undefined}
        data-session-fork-path-active={isFork && descriptor.activePath ? true : undefined}
      >
        {renderAgentSessionRow(row, {
          isFork,
          depth: descriptor.depth,
          forkCount: forks.length,
          expanded,
          onToggleExpanded: forks.length > 0 ? () => toggleForkParent(row.session.id) : undefined,
        })}
      </div>
    );
  };
  const renderParticipantSpaceList = (_spaces: ParticipantSpaceItem[], emptyMessage: string) => (
    <VirtualChatList
      rows={contactSidebarRows}
      activeSessionId={activeSidebarRowSessionId}
      scrollClassName="app-workspace-session-scroll min-h-0 flex-1"
      dataMode="participant-spaces-inline"
      renderRow={renderContactSidebarRow}
      emptyState={sidebarEmptyState(emptyMessage)}
    />
  );
  const renderAgentSessionList = (
    _rows: Array<{ session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem }>,
    emptyMessage: string,
  ) => (
    <>
      <div className="mb-1 flex shrink-0 justify-center px-1">
        <button
          type="button"
          onClick={() => {
            setChatCreateInitialMode('agent');
            setChatCreateAnchor(null);
            setIsChatCreateDialogOpen(true);
          }}
          className="app-participant-space-action app-participant-space-context-create inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[9px] px-2 text-[11px] font-medium transition"
          title="New My agent session"
          aria-label="New My agent session"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New session</span>
        </button>
      </div>
      <VirtualChatList
        rows={agentSidebarRows}
        activeSessionId={activeSidebarRowSessionId}
        scrollClassName="app-workspace-session-scroll min-h-0 flex-1"
        dataMode="agent-sessions-flat"
        renderRow={renderAgentSidebarRow}
        emptyState={sidebarEmptyState(emptyMessage)}
      />
    </>
  );

  return (
    <>
      <aside className={cn('app-side-shell app-workspace-sidebar overflow-hidden', isSingleWorkspacePage ? 'rounded-none' : 'rounded-bl-[22px] rounded-r-none')}>
      <div className="flex h-full">
        <div
          className={cn(
            'app-left-glass flex shrink-0 flex-col items-center justify-between px-2.5 pb-2.5',
            isNativeShell ? 'pt-11' : 'pt-2.5',
          )}
          style={{ width: `${LEFT_RAIL_WIDTH}px` }}
        >
          <div className="flex w-full flex-col items-center gap-4">
            {!isNativeShell && (
              <div className="flex w-full items-center justify-center gap-1.5 px-2.5 pt-1.5">
                <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
              </div>
            )}
            <div className="flex w-full flex-col items-center gap-3">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveNav(item.id)}
                    className="app-workspace-nav-button relative mx-auto grid h-11 w-11 place-items-center rounded-[14px] p-0"
                    data-active={active ? 'true' : 'false'}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                  >
                    <span className="relative grid h-8 w-8 place-items-center rounded-[14px]">
                      <Icon className="h-5 w-5" />
                      {item.id === 'chats' && totalUnread > 0 ? (
                        <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-white px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]">
                          {formatUnreadCount(totalUnread)}
                        </span>
                      ) : null}
                      {item.id === 'contacts' && pendingContactRequestCount > 0 ? (
                        <span
                          className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-emerald-300 px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]"
                          aria-label={`${formatUnreadCount(pendingContactRequestCount)} pending contact request${pendingContactRequestCount === 1 ? '' : 's'}`}
                        >
                          {formatUnreadCount(pendingContactRequestCount)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex w-full flex-col items-center gap-2">
            <SidebarProfileControl
              localProfileAvatarSeed={account.localProfileAvatarSeed}
              cloudAccount={account.cloudAccount}
              cloudAccountDialogTab={account.cloudAccountDialogTab}
              setCloudAccountDialogTab={account.setCloudAccountDialogTab}
              cloudSettings={account.cloudSettings}
              onUpdateCloudProfile={account.onUpdateCloudProfile}
              onCloudSignOut={account.onCloudSignOut}
            />
          </div>
        </div>

        {showSessionRail && !collapseChatSessions && (
          <div
            className={cn('app-session-panel overflow-hidden', isNativeShell ? 'pt-9' : '')}
            style={{ width: `${sessionRailWidth}px` }}
          >
            <div className="h-full overflow-hidden">
              {activeNav === 'chats' && (
                <div className="flex h-full flex-col p-2.5">
                  <div className="app-chat-sidebar-header mb-2 flex items-center justify-between gap-2.5">
                    <div>
                      <div className="text-[15px] font-semibold text-white">Chats</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-400">
                        <span>{chatConversations.length} total</span>
                        <span aria-hidden="true">•</span>
                        <span
                          className="app-collaboration-sync-status"
                          data-collaboration-sync-status={collaborationSyncStatus}
                          role="status"
                          aria-live="polite"
                          aria-label={collaborationSyncAriaLabel}
                        >
                          <span className="app-collaboration-sync-dot" aria-hidden="true" />
                          <span className="app-collaboration-sync-label">{chatStatusLabel}</span>
                        </span>
                      </div>
                    </div>
                    <div className="app-chat-sidebar-actions flex shrink-0 items-center gap-2">
                      <SidebarUpdater
                        isNativeShell={isNativeShell}
                        onCheckForUpdates={onCheckForUpdates}
                        onInstallUpdate={onInstallUpdate}
                        onRetryUpdate={onRetryUpdate}
                        onSubscribeToUpdate={onSubscribeToUpdate}
                        onOpenUpdateUrl={onOpenUpdateUrl}
                      />
                      <button
                        type="button"
                        onClick={openChatCreateDialog}
                        className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] p-0 transition"
                        title="Start a chat"
                        aria-label="Start a chat"
                      >
                        <Plus className="h-4 w-4 stroke-[2.2]" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="mb-2 px-1 text-[11px] leading-5 text-slate-500">
                    {chatChannel === 'contact'
                      ? 'People open as one flat chat; groups expand into sessions.'
                      : 'Each row is a # session with one of your agents.'}
                  </div>

                  <div className="app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 text-slate-400" />
                    <input
                      value={chatSearch}
                      onChange={(event) => setChatSearch(event.target.value)}
                      placeholder={chatChannel === 'contact' ? 'Search contacts, groups, sessions' : 'Search agent conversations'}
                      className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
                    />
                  </div>

                  <div className="mb-2 space-y-1.5">
                    <div className="app-filter-tabs w-full">
                      {([
                        { id: 'contact', label: 'Contact', unread: contactUnread },
                        { id: 'agent', label: 'Agent', unread: agentUnread },
                      ] as Array<{ id: ChatChannel; label: string; unread: number }>).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setChatChannel(tab.id)}
                          className={chatChannel === tab.id ? 'app-filter-tab app-filter-tab-active' : 'app-filter-tab'}
                        >
                          <span>{tab.label}</span>
                          {tab.unread > 0 ? (
                            <span className="ml-1.5 inline-flex">
                              <SidebarUnreadBadge count={tab.unread} scope="channel-tab" />
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>

                  {desktopChatError ? (
                    <div className="app-error-text mb-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
                      {desktopChatError}
                    </div>
                  ) : null}

                  {chatChannel === 'contact'
                    ? renderParticipantSpaceList(visibleContactParticipantSpaces, 'No conversations yet. Start a chat to see it here.')
                    : renderAgentSessionList(topLevelAgentSessions, 'No agent conversations yet. Start one to see it here.')}
                </div>
              )}

              {activeNav === 'projects' && (
                <SidebarProjectsPanel
                  projects={projects}
                  onOpenCreate={() => setIsCreateProjectDialogOpen(true)}
                />
              )}

              {activeNav === 'contacts' && (
                <SidebarContactsPanel directory={directory} />
              )}

              {activeNav === 'agents' && (
                <SidebarAgentsPanel directory={directory} />
              )}

              {activeNav === 'settings' && (
                <SidebarSettingsPanel />
              )}
            </div>
          </div>
        )}
      </div>
      </aside>

      {sessionContextMenu ? (
        <SessionContextMenu
          target={sessionContextMenu}
          onClose={() => setSessionContextMenu(null)}
          onRename={setRenameSessionTarget}
          onMove={setMoveSessionTarget}
          onDelete={setRemoveSessionTarget}
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

      {moveSessionTarget ? (
        <MoveSessionDialog
          target={moveSessionTarget}
          projects={runtimeProjects}
          onCancel={closeSessionDialogs}
          onMoveToProject={onMoveChatSessionToProject}
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
        space={selectedParticipantSpace}
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
