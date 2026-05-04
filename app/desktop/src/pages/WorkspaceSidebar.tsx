import { useEffect, useState } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import {
  Activity,
  ChevronDown,
  Copy,
  MoreHorizontal,
  Plus,
  Search,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { IdentityAvatar, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { navAccentClasses, navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import { primaryAgentForConversation } from '@/features/chat/participantSpaces';
import type { Agent, ChatChannel, Contact, ContactClass, ConversationType, NavId, ParticipantSpaceViewModel, SessionStatusIndicator } from '@/kordi-app/types';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import { cn } from '@/lib/utils';
import {
  DeleteSessionDialog,
  MoveSessionDialog,
  ProjectCreateDialog,
  SessionContextMenu,
  type SessionActionTarget,
  type SessionContextMenuTarget,
} from '@/pages/SessionActionOverlays';
import { ChatCreateDialog } from '@/pages/ChatCreateDialog';
import type { ChatCreatePopoverAnchor } from '@/pages/ChatCreateDialog';
import { GroupDetailsDialog } from '@/pages/GroupDetailsDialog';
import type { GroupManagementPopoverAnchor } from '@/pages/GroupDetailsDialog';

type ConversationItem = {
  id: string;
  canonicalSessionId?: string;
  name: string;
  subtitle: string;
  unread: number;
  messages: Array<{ time?: string }>;
  participants?: string[];
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
  type?: ConversationType;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
};

type ParticipantSpaceItem = ParticipantSpaceViewModel;

const CANONICAL_BRIDGE_SESSION_PREFIX = 'session:bridge:';
const LOCAL_RUNTIME_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function participantSpaceSessionRowTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return '# Untitled session';
  return trimmed.startsWith('#') ? trimmed : `# ${trimmed}`;
}

export function participantSpaceSessionIdLabel(session: { id?: string | null; canonicalSessionId?: string | null }) {
  const sessionId = (session.id || session.canonicalSessionId || '').trim();
  if (!sessionId || sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) return '';
  return `Session ID: ${sessionId}`;
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
  const visibleMessages = session.conversation.messages.filter((message) => message.role !== 'system' && message.text.trim().length > 0).length;
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
    && !sessionId.startsWith(CANONICAL_BRIDGE_SESSION_PREFIX);
}

export function sessionContextMenuTargetForConversation(
  conversation: ConversationItem,
  x: number,
  y: number,
): SessionContextMenuTarget | null {
  const sessionId = sessionActionIdForConversation(conversation);
  if (!sessionId) return null;

  return {
    sessionId,
    sessionName: conversation.name,
    x,
    y,
    canMoveToProject: canMoveConversationToProject(conversation, sessionId),
  };
}

type ProjectSessionItem = {
  id: string;
  name: string;
  summary?: string;
  lastActive: string;
  unread?: number;
  statusIndicator?: SessionStatusIndicator;
};

type ProjectItem = {
  id: string;
  name: string;
  root?: string;
  sessions: ProjectSessionItem[];
};

type ContactGroupItem = {
  id: ContactClass;
  label: string;
};

type ContactItem = Contact;

type AgentItem = Agent;

type BridgeHostSummary = {
  serverUrl: string;
  connected: boolean;
  nodeId?: string | null;
  humanId?: string | null;
  visiblePeerCount: number;
};

type WorkspaceSidebarProps = {
  isNativeShell: boolean;
  isSingleWorkspacePage: boolean;
  collapseChatSessions: boolean;
  showSessionRail: boolean;
  sessionRailWidth: number;
  activeNav: NavId;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  chatConversations: ConversationItem[];
  onCreateChatSession: () => void;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  isDesktopChatLoading: boolean;
  desktopChatError: string | null;
  participantSpaces: ParticipantSpaceItem[];
  contactParticipantSpaces: ParticipantSpaceItem[];
  agentParticipantSpaces: ParticipantSpaceItem[];
  initialSelectedParticipantSpaceId?: string | null;
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
  onStartChatWithPerson: (contact: ContactItem) => Promise<void> | void;
  onStartChatWithAgent: (agent: AgentItem) => Promise<void> | void;
  onCreateChatGroup: (request: CreateChatGroupRequest) => Promise<void> | void;
  onCreateChatSessionInParticipantSpace: (space: ParticipantSpaceItem) => Promise<void> | void;
  onRenameChatGroup: (sessionIds: string[], name: string) => Promise<void> | void;
  onAddChatGroupMembers: (sessionIds: string[], contactIds: string[]) => Promise<void> | void;
  onRemoveChatGroupMember: (sessionIds: string[], identityId: string) => Promise<void> | void;
  onSetChatGroupAdmin: (sessionIds: string[], identityId: string, isAdmin: boolean) => Promise<void> | void;
  onArchiveChatSession: (sessionId: string) => void;
  onDeleteChatSession: (sessionId: string) => void;
  onMoveChatSessionToProject: (sessionId: string, projectRoot: string) => void;
  onCreateProjectFromFolder: (folderPath: string, name?: string) => Promise<void> | void;
  onCreateProject: (name: string, parentDir?: string) => Promise<void> | void;
  runtimeProjects: ProjectItem[];
  projectSearch: string;
  setProjectSearch: Dispatch<SetStateAction<string>>;
  filteredProjects: ProjectItem[];
  activeProjectId: string;
  activeProjectSessionId: string;
  projectSelectedSessionIds: Record<string, string>;
  selectProject: (projectId: string, sessionId?: string) => void;
  expandedProjectIds: Record<string, boolean>;
  setExpandedProjectIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  onSelectProjectSession: (projectId: string, sessionId: string) => void;
  groupedContacts: Array<{ id: ContactClass; label: string; items: ContactItem[] }>;
  displayedContacts: ContactItem[];
  setActiveContactGroup: Dispatch<SetStateAction<ContactClass>>;
  setActiveContactId: Dispatch<SetStateAction<string>>;
  displayedAgents: AgentItem[];
  activeBridgeHost: BridgeHostSummary | null;
  localProfileAvatarSeed?: string | null;
  onRefreshBridge: () => void;
  onCopyBridgeHostUrl: () => void;
  onCreateBridgeDraft: () => void;
};

const SIDEBAR_STATUS_DOT_TONE: Record<SessionStatusIndicator['tone'], string> = {
  running: 'app-session-status-light-running',
  ready: 'app-session-status-light-ready',
  draft: 'app-session-status-light-draft',
  error: 'app-session-status-light-error',
  stopped: 'app-session-status-light-stopped',
};

export function SidebarSessionStatusIndicator({
  indicator,
}: {
  indicator?: SessionStatusIndicator;
}) {
  if (!indicator) return null;
  return (
    <span
      className={cn('app-session-status-light', SIDEBAR_STATUS_DOT_TONE[indicator.tone])}
      title={indicator.label}
      aria-label={indicator.label}
    />
  );
}

function SidebarUnreadBadge({ count, scope }: { count?: number; scope?: string }) {
  if (!count || count <= 0) return null;

  return (
    <span
      className="inline-flex min-w-[1.05rem] shrink-0 items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.18)]"
      data-unread-scope={scope}
      data-unread-count={count > 99 ? '99+' : count}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function SidebarSessionMetaColumn({
  timeLabel,
  unreadCount,
  unreadScope,
  indicator,
  active = false,
  reserveStatusSpace = true,
}: {
  timeLabel: string;
  unreadCount?: number;
  unreadScope?: string;
  indicator?: SessionStatusIndicator;
  active?: boolean;
  reserveStatusSpace?: boolean;
}) {
  const hasStatusLine = Boolean((unreadCount && unreadCount > 0) || indicator);
  return (
    <div className="flex min-w-[2.9rem] shrink-0 flex-col items-end gap-[0.3rem] pt-px">
      <span className={cn('app-session-meta-time whitespace-nowrap text-right text-[10px] font-medium leading-none tabular-nums tracking-[0.03em]', active && 'app-session-meta-time-active')}>
        {timeLabel}
      </span>
      {reserveStatusSpace || hasStatusLine ? (
        <div className="flex h-2.5 items-center justify-end gap-1.5 self-end">
          <SidebarUnreadBadge count={unreadCount} scope={unreadScope} />
          <SidebarSessionStatusIndicator indicator={indicator} />
        </div>
      ) : null}
    </div>
  );
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
    return `Person • ${sessionText}`;
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

  if (avatars.length === 1) {
    const avatar = avatars[0];
    return (
      <div className="relative h-9 w-9 shrink-0">
        <IdentityAvatar
          kind={avatar.kind}
          seed={avatar.seed}
          name={space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-9 w-9 border border-white/10"
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
            className="h-7 w-7 border border-slate-950/80 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
          />
        </span>
      ))}
    </div>
  );
}

export function WorkspaceSidebar({
  isNativeShell,
  isSingleWorkspacePage,
  collapseChatSessions,
  showSessionRail,
  sessionRailWidth,
  activeNav,
  setActiveNav,
  chatConversations,
  chatSearch,
  setChatSearch,
  desktopChatError,
  participantSpaces,
  contactParticipantSpaces,
  agentParticipantSpaces,
  initialSelectedParticipantSpaceId = null,
  activeConvId,
  onSelectChatSession,
  onStartChatWithPerson,
  onStartChatWithAgent,
  onCreateChatGroup,
  onCreateChatSessionInParticipantSpace,
  onRenameChatGroup,
  onAddChatGroupMembers,
  onRemoveChatGroupMember,
  onSetChatGroupAdmin,
  onArchiveChatSession,
  onDeleteChatSession,
  onMoveChatSessionToProject,
  onCreateProjectFromFolder,
  onCreateProject,
  runtimeProjects,
  projectSearch,
  setProjectSearch,
  filteredProjects,
  activeProjectId,
  activeProjectSessionId,
  projectSelectedSessionIds,
  selectProject,
  expandedProjectIds,
  setExpandedProjectIds,
  onSelectProjectSession,
  groupedContacts,
  displayedContacts,
  setActiveContactGroup,
  setActiveContactId,
  displayedAgents,
  activeBridgeHost,
  localProfileAvatarSeed,
  onRefreshBridge,
  onCopyBridgeHostUrl,
  onCreateBridgeDraft,
}: WorkspaceSidebarProps) {
  const totalUnread = chatConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread ?? 0), 0);
  const formatUnreadCount = (value: number) => (value > 99 ? '99+' : `${value}`);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuTarget | null>(null);
  const [removeSessionTarget, setRemoveSessionTarget] = useState<SessionActionTarget | null>(null);
  const [moveSessionTarget, setMoveSessionTarget] = useState<SessionActionTarget | null>(null);
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
  const [isChatCreateDialogOpen, setIsChatCreateDialogOpen] = useState(false);
  const [chatCreateAnchor, setChatCreateAnchor] = useState<ChatCreatePopoverAnchor | null>(null);
  const [isGroupDetailsDialogOpen, setIsGroupDetailsDialogOpen] = useState(false);
  const [groupDetailsAnchor, setGroupDetailsAnchor] = useState<GroupManagementPopoverAnchor | null>(null);
  const [selectedParticipantSpaceId, setSelectedParticipantSpaceId] = useState<string | null>(initialSelectedParticipantSpaceId);
  const [chatChannel, setChatChannel] = useState<ChatChannel>('contact');
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const activeParticipantSpaceId = participantSpaces.find((space) => (
    space.sessions.some((session) => session.id === activeConvId || session.canonicalSessionId === activeConvId)
  ))?.id ?? null;
  const selectedParticipantSpace = selectedParticipantSpaceId
    ? participantSpaces.find((space) => space.id === selectedParticipantSpaceId) ?? null
    : null;
  const openChatCreateDialog = (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActiveNav('chats');
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
    if (selectedParticipantSpaceId && !participantSpaces.some((space) => space.id === selectedParticipantSpaceId)) {
      setSelectedParticipantSpaceId(null);
    }
  }, [participantSpaces, selectedParticipantSpaceId]);

  const closeSessionDialogs = () => {
    setRemoveSessionTarget(null);
    setMoveSessionTarget(null);
  };

  const renderParticipantSpaceItem = (space: ParticipantSpaceItem) => {
    const latestSession = space.sessions[0];
    const isActiveSpace = activeParticipantSpaceId === space.id;
    const isSelectedSpace = selectedParticipantSpaceId === space.id;
    const isExpanded = isSelectedSpace || isActiveSpace;
    const isAutoExpanded = isActiveSpace && !isSelectedSpace;
    const visibleSessions = isAutoExpanded
      ? space.sessions.filter((session) => session.id === activeConvId || session.canonicalSessionId === activeConvId)
      : space.sessions;
    const rowTimeLabel = space.updatedAtLabel ?? latestSession?.updatedAtLabel ?? '--:--';
    const toggleSpace = () => {
      setSelectedParticipantSpaceId((current) => current === space.id ? null : space.id);
    };
    return (
      <div
        key={space.id}
        className={cn('app-participant-space-inline-group', isExpanded && 'app-participant-space-inline-group-expanded')}
        data-participant-space-auto-expanded={isAutoExpanded ? 'true' : undefined}
      >
        <div
          className={cn('app-participant-space-row-shell', (isActiveSpace || isExpanded) && 'app-participant-space-row-shell-active')}
          data-participant-space-row-shell="true"
        >
          <button
            type="button"
            data-testid="participant-space-row"
            data-participant-space-toggle="true"
            aria-expanded={isExpanded}
            onClick={toggleSpace}
            className="app-session-row app-participant-space-row-button w-full min-w-0 text-left text-white"
          >
            <ParticipantSpaceAvatarStack space={space} />
            <div className="min-w-0">
              <div className="app-participant-space-row-title truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={space.title}>{space.title}</div>
              <div className={cn('app-participant-space-row-preview mt-px truncate text-[10.5px] leading-[0.98rem]', (isActiveSpace || isExpanded) && 'app-participant-space-row-preview-active')} title={space.preview}>
                {space.preview || `${participantSpaceKindText(space)} space`}
              </div>
              <div className="app-participant-space-row-detail mt-px truncate text-[10px] leading-[0.88rem]">
                {participantSpaceDetailText(space)}
              </div>
            </div>
          </button>
          <div className="app-participant-space-row-side">
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
                className="app-participant-space-action app-participant-space-context-create grid h-6 w-6 place-items-center rounded-[8px] transition"
                aria-label={`Create session in ${space.title}`}
                title={`Create session in ${space.title}`}
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
            <div className="app-participant-space-row-meta">
              <SidebarSessionMetaColumn
                timeLabel={rowTimeLabel}
                unreadCount={isExpanded ? 0 : space.unread}
                unreadScope="participant-space"
                indicator={isExpanded ? undefined : latestSession?.statusIndicator}
                active={isActiveSpace || isExpanded}
                reserveStatusSpace={false}
              />
            </div>
          </div>
        </div>

        {isExpanded ? (
          <div className="app-participant-space-inline-sessions mt-0.5 space-y-px">
            {visibleSessions.map((session) => {
              const conversation = session.conversation;
              const isActive = activeConvId === session.id || activeConvId === session.canonicalSessionId;
              const sessionRowTimeLabel = session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
              const sessionPreview = participantSpaceSessionPreviewText(session.preview) || 'No messages yet';
              const sessionRowTitle = participantSpaceSessionRowTitle(session.title);
              const sessionMessageCount = participantSpaceSessionMessageCount(session);
              const sessionPreviewLine = participantSpaceSessionPreviewLine(sessionPreview, sessionMessageCount);
              const sessionIdLabel = participantSpaceSessionIdLabel(session);
              return (
                <button
                  key={session.id}
                  type="button"
                  data-testid="participant-space-session-row"
                  data-session-preview={sessionPreview}
                  data-session-preview-line={sessionPreviewLine}
                  data-session-id-label={sessionIdLabel}
                  data-session-message-count={sessionMessageCount}
                  data-session-updated-at={sessionRowTimeLabel}
                  onClick={() => onSelectChatSession(session.id)}
                  onContextMenu={(event) => {
                    const target = sessionContextMenuTargetForConversation(conversation, event.clientX, event.clientY);
                    if (!target) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setSessionContextMenu(target);
                  }}
                  className={cn('app-session-row app-participant-space-session-row w-full px-2.5 py-1.5 text-left text-white', isActive && 'app-session-row-active')}
                >
                  <div className="min-w-0">
                    <div className="app-participant-space-session-title truncate text-[12px] font-medium" title={sessionRowTitle}>{sessionRowTitle}</div>
                    {sessionIdLabel ? (
                      <div className="app-participant-space-session-id mt-px truncate text-[9.5px] leading-[0.9rem] text-slate-500" title={sessionIdLabel}>{sessionIdLabel}</div>
                    ) : null}
                    <div
                      className={cn(
                        'app-participant-space-session-preview mt-px truncate text-[10.5px] leading-[1.05rem]',
                        isActive ? 'text-slate-300' : 'text-slate-500',
                        session.statusIndicator?.live && 'app-participant-space-session-preview-live',
                      )}
                      title={sessionPreviewLine}
                    >
                      {sessionPreviewLine}
                    </div>
                  </div>
                  <SidebarSessionMetaColumn
                    timeLabel={sessionRowTimeLabel}
                    unreadCount={session.unread}
                    unreadScope="participant-session"
                    indicator={session.statusIndicator}
                    active={isActive}
                  />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderParticipantSpaceList = (spaces: ParticipantSpaceItem[], emptyMessage: string) => (
    <ScrollArea className="app-workspace-session-scroll min-h-0 flex-1" data-chat-sidebar-mode="participant-spaces-inline">
      <div className="w-full space-y-0.5">
        {spaces.length > 0 ? spaces.map(renderParticipantSpaceItem) : (
          <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">
            {emptyMessage}
          </div>
        )}
      </div>
    </ScrollArea>
  );

  const flatAgentSessions = agentParticipantSpaces
    .flatMap((space) => space.sessions.map((session) => ({ session, space })))
    .sort((left, right) => right.session.updatedAtMs - left.session.updatedAtMs
      || left.session.title.localeCompare(right.session.title));

  const renderAgentSessionRow = ({ session, space }: { session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem }) => {
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
    return (
      <button
        key={session.id}
        type="button"
        data-testid="agent-session-row"
        data-session-preview={sessionPreview}
        data-session-preview-line={sessionPreviewLine}
        data-session-message-count={sessionMessageCount}
        data-session-updated-at={rowTimeLabel}
        onClick={() => onSelectChatSession(session.id)}
        onContextMenu={(event) => {
          const target = sessionContextMenuTargetForConversation(conversation, event.clientX, event.clientY);
          if (!target) return;
          event.preventDefault();
          event.stopPropagation();
          setSessionContextMenu(target);
        }}
        className={cn('app-session-row flex w-full min-w-0 items-start gap-2 px-2.5 py-1.5 text-left text-white', isActive && 'app-session-row-active')}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={sessionRowTitle}>{sessionRowTitle}</span>
            <div className="inline-flex shrink-0 items-center gap-1.5">
              <SidebarUnreadBadge count={session.unread} scope="agent-session" />
              <SidebarSessionStatusIndicator indicator={session.statusIndicator} active={isActive} />
              <span className={cn('app-session-meta-time whitespace-nowrap text-[10px] font-medium leading-none tabular-nums tracking-[0.03em] text-slate-400', isActive && 'app-session-meta-time-active')}>
                {rowTimeLabel}
              </span>
            </div>
          </div>
          <div
            className={cn(
              'mt-0.5 truncate text-[10.5px] leading-[1rem]',
              isActive ? 'text-slate-300' : 'text-slate-500',
              session.statusIndicator?.live && 'app-participant-space-session-preview-live',
            )}
            title={subtitleLine}
          >
            {subtitleLine}
          </div>
        </div>
      </button>
    );
  };

  const renderAgentSessionList = (rows: Array<{ session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem }>, emptyMessage: string) => (
    <ScrollArea className="app-workspace-session-scroll min-h-0 flex-1" data-chat-sidebar-mode="agent-sessions-flat">
      <div className="w-full space-y-0.5">
        {rows.length > 0 ? rows.map(renderAgentSessionRow) : (
          <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">
            {emptyMessage}
          </div>
        )}
      </div>
    </ScrollArea>
  );

  return (
    <>
      <aside className={cn('app-side-shell app-workspace-sidebar overflow-hidden', isSingleWorkspacePage ? 'rounded-none' : 'rounded-bl-[22px] rounded-r-none')}>
      <div className="flex h-full">
        <div
          className={cn(
            'app-left-glass flex shrink-0 flex-col items-center justify-between px-2.5 pb-2.5',
            isNativeShell ? 'pt-11' : 'pt-2.5',
            collapseChatSessions || isSingleWorkspacePage ? '' : 'shadow-[inset_-1px_0_0_rgba(255,255,255,0.05)]',
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
            <div className="flex w-full flex-col items-center gap-2.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveNav(item.id)}
                    className={cn(
                      'app-workspace-nav-button app-list-item relative mx-auto grid h-11 w-11 place-items-center rounded-[18px] p-0 transition',
                      active ? 'app-list-item-active text-white' : 'text-slate-300 hover:text-white',
                    )}
                    aria-label={item.label}
                    title={item.label}
                  >
                    <span className="relative grid h-8 w-8 place-items-center rounded-[14px]">
                      <Icon className={cn('h-[17px] w-[17px]', active ? navAccentClasses[item.id] : 'text-slate-300')} />
                      {item.id === 'chats' && totalUnread > 0 ? (
                        <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-white px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]">
                          {formatUnreadCount(totalUnread)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex w-full flex-col items-center gap-2">
            <Button size="icon" className="h-9 w-9 rounded-[14px]" onClick={openChatCreateDialog} aria-label="Start a chat">
              <Plus className="h-4 w-4" />
            </Button>
            <IdentityAvatar
              kind="human"
              seed={localProfileAvatarSeed || currentLocalProfileAvatarSeed}
              name="Local profile"
              className="h-9 w-9 border border-white/10"
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
                  <div className="mb-2 flex items-start justify-between gap-2.5">
                    <div>
                      <div className="text-[15px] font-semibold text-white">Chats</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {chatConversations.length} total • {totalUnread > 0 ? `${formatUnreadCount(totalUnread)} unread` : 'all caught up'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={openChatCreateDialog}
                      className="app-icon-button app-utility-button flex h-8 w-8 items-center justify-center rounded-[12px] text-slate-200"
                      title="Start a chat"
                      aria-label="Start a chat"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mb-2 px-1 text-[11px] leading-5 text-slate-500">
                    {chatChannel === 'contact'
                      ? 'Expand a contact or group to see its sessions.'
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
                        { id: 'contact', label: 'Contact' },
                        { id: 'agent', label: 'Agent' },
                      ] as Array<{ id: ChatChannel; label: string }>).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setChatChannel(tab.id)}
                          className={chatChannel === tab.id ? 'app-filter-tab app-filter-tab-active' : 'app-filter-tab'}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {desktopChatError ? (
                    <div className="mb-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
                      {desktopChatError}
                    </div>
                  ) : null}

                  {chatChannel === 'contact'
                    ? renderParticipantSpaceList(contactParticipantSpaces, 'No conversations yet. Start a chat to see it here.')
                    : renderAgentSessionList(flatAgentSessions, 'No agent conversations yet. Start one to see it here.')}
                </div>
              )}

              {activeNav === 'projects' && (
                <div className="flex h-full flex-col p-2.5 text-white">
                  <div className="mb-2 flex items-start justify-between gap-2.5">
                    <div>
                      <div className="text-[15px] font-semibold text-white">Projects</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">{runtimeProjects.length} workspaces with shared context and sessions</div>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="app-icon-button h-8 w-8 rounded-lg border-0"
                      title="Create project"
                      aria-label="Create project"
                      onClick={() => setIsCreateProjectDialogOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 text-slate-400" />
                    <input
                      value={projectSearch}
                      onChange={(event) => setProjectSearch(event.target.value)}
                      placeholder="Search projects"
                      className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
                    />
                  </div>

                  <ScrollArea className="app-workspace-session-scroll min-h-0 flex-1">
                    <div className="w-full space-y-1.5">
                      {filteredProjects.map((project) => {
                        const isExpanded = expandedProjectIds[project.id] ?? false;

                        return (
                          <div key={project.id} className="app-project-group rounded-[18px] px-1 py-1">
                            <button
                              type="button"
                              onClick={() => {
                                const rememberedSessionId = projectSelectedSessionIds[project.id];
                                const currentProjectSessionId =
                                  activeProjectId === project.id
                                    ? activeProjectSessionId
                                    : (project.sessions.find((session) => session.id === rememberedSessionId)?.id
                                        ?? project.sessions[0]?.id
                                        ?? '');

                                selectProject(project.id, currentProjectSessionId || undefined);
                                setExpandedProjectIds((current) => ({
                                  ...current,
                                  [project.id]: current[project.id] === undefined ? true : !current[project.id],
                                }));
                              }}
                              className="app-project-group-toggle flex w-full items-center justify-between gap-2 rounded-[14px] px-3 py-2 text-left transition"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-medium text-white">{project.name}</div>
                                <div className="mt-0.5 text-[11px] text-slate-400">{project.sessions.length} sessions</div>
                              </div>
                              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', isExpanded ? 'rotate-180' : '')} />
                            </button>

                            {isExpanded && (
                              <div className="app-project-session-list ml-3 mt-1 pl-3">
                                <div className="space-y-0.5">
                                  {project.sessions.map((session) => {
                                    const isActiveSession =
                                      activeProjectId === project.id && activeProjectSessionId === session.id;

                                    return (
                                      <button
                                        key={session.id}
                                        type="button"
                                        onClick={() => onSelectProjectSession(project.id, session.id)}
                                        className={cn(
                                          'app-project-session-row block w-full min-w-0 rounded-[12px] border border-transparent px-2.5 py-[0.3125rem] text-left transition',
                                          isActiveSession
                                            ? 'border-white/10 bg-white/[0.055] text-white'
                                            : 'text-slate-300 hover:bg-white/[0.025] hover:text-white',
                                        )}
                                      >
                                        <div className="min-w-0">
                                          <div className="flex items-start gap-2.5">
                                            <div className="min-w-0 flex-1">
                                              <div className="truncate text-[12px] font-medium">{session.name}</div>
                                            </div>
                                            <SidebarSessionMetaColumn
                                              timeLabel={session.lastActive}
                                              unreadCount={session.unread}
                                              indicator={session.statusIndicator}
                                              active={isActiveSession}
                                            />
                                          </div>
                                          {session.summary?.trim().length ? (
                                            <div className={cn('mt-px truncate text-[11px] leading-[1.05rem]', isActiveSession ? 'text-slate-300' : 'text-slate-500')}>
                                              {session.summary}
                                            </div>
                                          ) : null}
                                          <div className={cn('mt-px truncate font-mono text-[10px] leading-[0.95rem]', isActiveSession ? 'text-slate-400' : 'text-slate-600')} title={session.id}>
                                            id {session.id}
                                          </div>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {activeNav === 'contacts' && (
                <div className="h-full p-3">
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-slate-300">
                    <Search className="h-4 w-4" />
                    <span className="text-sm">Search people and agents</span>
                  </div>
                  <div className="mb-2 grid gap-1.5">
                    {groupedContacts.map((group) => (
                      <button
                        key={group.id}
                        onClick={() => {
                          setActiveContactGroup(group.id);
                          const first = displayedContacts.find((contact) => contact.classType === group.id);
                          if (first) setActiveContactId(first.id);
                        }}
                        className={`flex items-center justify-between rounded-xl px-3 py-2 text-left transition ${
                          activeNav === 'contacts'
                            ? 'bg-white/12 text-white ring-1 ring-white/15'
                            : 'bg-white/5 text-white hover:bg-white/10'
                        }`}
                      >
                        <span className="text-sm font-medium">{group.label}</span>
                        <Badge
                          variant={activeNav === 'contacts' ? 'secondary' : 'outline'}
                          className={`rounded-full ${activeNav === 'contacts' ? 'text-slate-950' : 'text-slate-200 border-white/15'}`}
                        >
                          A-Z
                        </Badge>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-slate-400">
                    Compact messenger-style contacts. Select a row to view details.
                  </div>
                </div>
              )}

              {activeNav === 'agents' && (
                <div className="flex h-full flex-col p-3">
                  <ScrollArea className="min-h-0 flex-1 pr-2">
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-slate-400">Agents</div>
                        <div className="text-xl font-semibold text-white">{displayedAgents.length} visible identities</div>
                      </div>
                      <Button className="rounded-xl">
                        <Plus className="mr-2 h-4 w-4" />New
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {displayedAgents.map((agent) => (
                        <Card key={agent.id} className="rounded-3xl border-white/10 bg-white/5 text-white shadow-none">
                          <CardContent className="p-4">
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <IdentityAvatar
                                  kind="agent"
                                  seed={agent.avatarSeed ?? agent.id}
                                  name={agent.name}
                                  imageUrl={agent.profileImageUrl}
                                  className="h-10 w-10 border border-white/10"
                                />
                                <div className="min-w-0">
                                  <div className="truncate font-medium">{agent.name}</div>
                                  <div className="truncate text-xs text-slate-400">{agent.id}</div>
                                </div>
                              </div>
                              <Badge variant="outline" className="shrink-0 border-white/20 text-slate-200">
                                {agent.status}
                              </Badge>
                            </div>
                            <div className="mb-2 text-sm text-slate-300">{agent.role}</div>
                            <div className="mb-3 text-xs text-slate-400">Messaging: {agent.messaging}</div>
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span>{agent.tasks} active tasks</span>
                              <Button size="sm" variant="secondary" className="rounded-xl">
                                Open
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {activeNav === 'bridge' && (
                <div className="h-full p-3">
                  <div className="app-sidebar-panel space-y-3 text-white">
                    <div className="app-sidebar-panel-section">
                      <div className="app-sidebar-panel-heading">Active host</div>
                      <div className="app-sidebar-meta-list mt-2.5">
                        <div className="app-sidebar-meta-row"><span>Server</span><span className="max-w-[180px] truncate text-right">{activeBridgeHost?.serverUrl || 'Not set'}</span></div>
                        <div className="app-sidebar-meta-row"><span>Connection</span><span>{activeBridgeHost?.connected ? 'Connected' : 'Offline'}</span></div>
                        <div className="app-sidebar-meta-row"><span>Local node</span><span className="max-w-[180px] truncate text-right">{activeBridgeHost?.nodeId || 'Not registered'}</span></div>
                        <div className="app-sidebar-meta-row"><span>Visible members</span><span>{activeBridgeHost?.visiblePeerCount ?? 0}</span></div>
                      </div>
                    </div>
                    <div className="app-sidebar-panel-section">
                      <div className="app-sidebar-panel-heading">Quick actions</div>
                      <div className="mt-2.5 grid gap-2">
                        <Button variant="secondary" className="justify-start rounded-xl" onClick={onRefreshBridge}>
                          <Activity className="mr-2 h-4 w-4" /> Refresh bridge state
                        </Button>
                        <Button variant="secondary" className="justify-start rounded-xl" onClick={onCopyBridgeHostUrl}>
                          <Copy className="mr-2 h-4 w-4" /> Copy host URL
                        </Button>
                        <Button variant="secondary" className="justify-start rounded-xl" onClick={onCreateBridgeDraft}>
                          <Plus className="mr-2 h-4 w-4" /> Add / join another host
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeNav === 'settings' && (
                <div className="h-full p-3">
                  <div className="app-sidebar-panel space-y-1.5 text-white">
                    {['Profile', 'Notifications', 'Appearance', 'Privacy', 'Developer'].map((section) => (
                      <button key={section} type="button" className="app-sidebar-nav-row flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 text-left transition">
                        <div>
                          <div className="text-[13px] font-medium">{section}</div>
                          <div className="text-[11px] text-slate-400">Open {section.toLowerCase()} settings</div>
                        </div>
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      </button>
                    ))}
                  </div>
                </div>
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
          onMove={setMoveSessionTarget}
          onArchive={onArchiveChatSession}
          onDelete={setRemoveSessionTarget}
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
        isOpen={isChatCreateDialogOpen}
        contacts={displayedContacts}
        agents={displayedAgents}
        onClose={() => {
          setIsChatCreateDialogOpen(false);
          setChatCreateAnchor(null);
        }}
        onStartPerson={onStartChatWithPerson}
        onStartAgent={onStartChatWithAgent}
        onCreateGroup={onCreateChatGroup}
        anchorRect={chatCreateAnchor}
      />

      <GroupDetailsDialog
        isOpen={isGroupDetailsDialogOpen}
        space={selectedParticipantSpace}
        contacts={displayedContacts}
        onClose={() => {
          setIsGroupDetailsDialogOpen(false);
          setGroupDetailsAnchor(null);
        }}
        onRename={onRenameChatGroup}
        onAddMembers={onAddChatGroupMembers}
        onRemoveMember={onRemoveChatGroupMember}
        onSetAdmin={onSetChatGroupAdmin}
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
