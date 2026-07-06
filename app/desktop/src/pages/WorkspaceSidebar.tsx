import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import {
  Check,
  ChevronDown,
  RefreshCw,
  Copy,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { IdentityAvatar, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { CloudAccountSettingsDialog, type CloudAccountSettingsConfig, type CloudAccountSettingsTabId } from '@/pages/CloudAccountSettingsDialog';
import { navAccentClasses, navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import { primaryAgentForConversation } from '@/features/chat/participantSpaces';
import type {
  Agent,
  ChatChannel,
  Contact,
  ContactClass,
  ConversationType,
  NavId,
  ParticipantSpaceViewModel,
  SessionStatusIndicator,
} from '@/kordi-app/types';
import type { CloudAccount } from '@/features/cloud/authClient';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from '@/features/cloud/avatar';
import { buildForkLineage, isGroupForkSession } from '@/features/chat/forkLineage';
import { ChevronRight as ChevronRightIcon, Split } from 'lucide-react';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
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
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
};

type ParticipantSpaceItem = ParticipantSpaceViewModel;

function filterGroupForkSessionsFromSpaces(spaces: ParticipantSpaceItem[]): ParticipantSpaceItem[] {
  return spaces
    .map((space) => ({
      ...space,
      sessions: space.sessions.filter((session) => !isGroupForkSession(session)),
    }))
    .filter((space) => space.sessions.length > 0);
}

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

type DesktopUpdateCheckResult = {
  status: 'updateAvailable' | 'upToDate' | 'unavailable';
  currentVersion: string;
  latestVersion?: string | null;
  changelogUrl?: string | null;
  downloadUrl?: string | null;
  signature?: string | null;
  installCommand?: string | null;
  message: string;
};

type DesktopUpdateInstallResult = {
  status: 'installing';
  version?: string | null;
  downloadedPath: string;
  message: string;
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
  onCheckForUpdates?: () => Promise<DesktopUpdateCheckResult>;
  onInstallUpdate?: (input: { downloadUrl: string; version?: string | null }) => Promise<DesktopUpdateInstallResult>;
  onOpenUpdateUrl?: (url: string) => Promise<void> | void;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  isDesktopChatLoading: boolean;
  desktopChatError: string | null;
  participantSpaces: ParticipantSpaceItem[];
  contactParticipantSpaces: ParticipantSpaceItem[];
  agentParticipantSpaces: ParticipantSpaceItem[];
  initialSelectedParticipantSpaceId?: string | null;
  initialChatChannel?: ChatChannel;
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
  onStartChatWithPerson: (contact: ContactItem) => Promise<void> | void;
  onStartChatWithAgent: (agent: AgentItem) => Promise<void> | void;
  onCreateChatGroup: (request: CreateChatGroupRequest) => Promise<void> | void;
  onAddContactByNodeId: (nodeId: string) => Promise<void> | void;
  /** Optional account lookup. When provided, the Add-contacts surface
   * inside the chat-create dialog switches to a search-first UX. */
  onLookupContact?: (idOrEmail: string) => Promise<import('@/pages/ChatCreateDialog').AddContactLookupResult | null>;
  /** Override the placeholder text shown in the Add-contacts input. */
  addContactPlaceholder?: string;
  onCreateChatSessionInParticipantSpace: (space: ParticipantSpaceItem) => Promise<void> | void;
  onRenameChatGroup: (sessionIds: string[], name: string) => Promise<void> | void;
  onRenameChatSession: (sessionId: string, title: string) => void;
  onAddChatGroupMembers: (sessionIds: string[], contactIds: string[]) => Promise<void> | void;
  onRemoveChatGroupMember: (sessionIds: string[], identityId: string) => Promise<void> | void;
  onSetChatGroupAdmin: (sessionIds: string[], identityId: string, isAdmin: boolean) => Promise<void> | void;
  onDeleteChatSession: (sessionId: string) => void | Promise<void>;
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
  addableContacts: ContactItem[];
  contactRequestCount: number;
  setActiveContactGroup: Dispatch<SetStateAction<ContactClass>>;
  setActiveContactId: Dispatch<SetStateAction<string>>;
  displayedAgents: AgentItem[];
  activeBridgeHost: BridgeHostSummary | null;
  localProfileAvatarSeed?: string | null;
  cloudAccount?: CloudAccount | null;
  cloudAccountDialogTab?: CloudAccountSettingsTabId | null;
  setCloudAccountDialogTab?: Dispatch<SetStateAction<CloudAccountSettingsTabId | null>>;
  cloudSettings?: CloudAccountSettingsConfig;
  onUpdateCloudProfile?: (input: { displayName?: string; avatarUrl?: string }) => Promise<void>;
  onCloudSignOut?: () => Promise<void> | void;
  isBridgePolling: boolean;
  onRefreshBridge: () => void;
  onCopyBridgeHostUrl: () => void;
  onCreateBridgeDraft: () => void;
};

export type CloudProfileRow = { label: string; value: string; copyable?: boolean };

export function buildCloudProfileRows(account: CloudAccount | null | undefined): CloudProfileRow[] {
  if (!account) return [];
  return [
    account.primaryEmail?.trim() ? { label: 'Email', value: account.primaryEmail.trim() } : null,
    { label: 'Account ID', value: account.accountId, copyable: true },
  ].filter((row): row is CloudProfileRow => Boolean(row));
}

const CLOUD_PROFILE_COPY_RESET_MS = 1800;

export function CloudProfileRowCopyButton({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setStatus('idle');
      resetTimerRef.current = null;
    }, CLOUD_PROFILE_COPY_RESET_MS);
  };

  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setStatus('error');
      scheduleReset();
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('error');
    } finally {
      scheduleReset();
    }
  };

  const copied = status === 'copied';
  const errored = status === 'error';
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11px] font-semibold transition',
        copied
          ? 'bg-emerald-500/15 text-emerald-200'
          : errored
            ? 'bg-red-500/15 text-red-200'
            : 'text-slate-200 hover:bg-white/10 hover:text-white',
      )}
      aria-label={copied ? `${label} copied` : errored ? `Copy ${label} failed` : `Copy ${label}`}
      aria-live="polite"
      onClick={() => { void handleCopy(); }}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      {copied ? 'Copied' : errored ? 'Copy failed' : 'Copy'}
    </button>
  );
}

const SIDEBAR_STATUS_DOT_TONE: Record<SessionStatusIndicator['tone'], string> = {
  running: 'app-session-status-light-running',
  ready: 'app-session-status-light-ready',
  draft: 'app-session-status-light-draft',
  error: 'app-session-status-light-error',
  stopped: 'app-session-status-light-stopped',
};

export function CloudProfileLogoutAction({
  onSignOut,
  disabled = false,
}: {
  onSignOut: () => Promise<void> | void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[12px] font-semibold text-red-200',
        'transition hover:bg-red-400/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-60',
      )}
      aria-label="Logout of account"
      disabled={disabled}
      onClick={() => void onSignOut()}
    >
      <span>Logout</span>
    </button>
  );
}

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
      className="app-sidebar-unread-badge inline-flex min-w-[1.05rem] shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none"
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
      <span className={cn('app-session-meta-time whitespace-nowrap text-right text-[10px] font-medium leading-none tabular-nums', active && 'app-session-meta-time-active')}>
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
  isNativeShell,
  isSingleWorkspacePage,
  collapseChatSessions,
  showSessionRail,
  sessionRailWidth,
  activeNav,
  setActiveNav,
  chatConversations,
  onCreateChatSession,
  onCheckForUpdates,
  onInstallUpdate,
  onOpenUpdateUrl,
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
  addableContacts,
  contactRequestCount,
  setActiveContactGroup,
  setActiveContactId,
  displayedAgents,
  activeBridgeHost,
  localProfileAvatarSeed,
  cloudAccount,
  cloudAccountDialogTab: controlledCloudAccountDialogTab,
  setCloudAccountDialogTab: setControlledCloudAccountDialogTab,
  cloudSettings,
  onUpdateCloudProfile,
  onCloudSignOut,
  isBridgePolling,
  onRefreshBridge,
  onCopyBridgeHostUrl,
  onCreateBridgeDraft,
}: WorkspaceSidebarProps) {
  const totalUnread = chatConversations.reduce((sum, conversation) => (
    isGroupForkSession(conversation) ? sum : sum + Math.max(0, conversation.unread ?? 0)
  ), 0);
  const pendingContactRequestCount = Math.max(0, contactRequestCount);
  const formatUnreadCount = (value: number) => (value > 99 ? '99+' : `${value}`);
  const bridgeSyncStatus = isBridgePolling ? 'syncing' : 'idle';
  const chatStatusLabel = isBridgePolling
    ? 'syncing…'
    : totalUnread > 0
      ? `${formatUnreadCount(totalUnread)} unread`
      : 'all caught up';
  const bridgeSyncAriaLabel = isBridgePolling
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
  const [isProfileCardOpen, setIsProfileCardOpen] = useState(false);
  const [localCloudAccountDialogTab, setLocalCloudAccountDialogTab] = useState<CloudAccountSettingsTabId | null>(null);
  const isCloudAccountDialogControlled = Boolean(setControlledCloudAccountDialogTab);
  const cloudAccountDialogTab = isCloudAccountDialogControlled
    ? (controlledCloudAccountDialogTab ?? null)
    : localCloudAccountDialogTab;
  const setCloudAccountDialogTab = setControlledCloudAccountDialogTab ?? setLocalCloudAccountDialogTab;
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const profilePopoverRef = useRef<HTMLDivElement | null>(null);
  // Computed each time the popover opens, so the surface anchors to the avatar's
  // actual on-screen position (not just a fixed bottom-left offset).
  const [profilePopoverAnchor, setProfilePopoverAnchor] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    if (!isProfileCardOpen) {
      setProfilePopoverAnchor(null);
      return;
    }
    const trigger = profileTriggerRef.current;
    if (!trigger) return;
    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      setProfilePopoverAnchor({
        left: rect.right + 8,
        bottom: Math.max(8, window.innerHeight - rect.bottom),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [isProfileCardOpen]);

  useEffect(() => {
    if (!isProfileCardOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (profilePopoverRef.current?.contains(target)) return;
      if (profileTriggerRef.current?.contains(target)) return;
      setIsProfileCardOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsProfileCardOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isProfileCardOpen]);
  const [chatCreateAnchor, setChatCreateAnchor] = useState<ChatCreatePopoverAnchor | null>(null);
  const [updateCheckResult, setUpdateCheckResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [isUpdateConfirmOpen, setIsUpdateConfirmOpen] = useState(false);
  const [updateConfirmAnchor, setUpdateConfirmAnchor] = useState<{ left: number; top: number } | null>(null);
  const [isUpdateCheckPending, setIsUpdateCheckPending] = useState(false);
  const [updateInstallState, setUpdateInstallState] = useState<{ status: 'idle' | 'installing' | 'error'; message?: string }>({ status: 'idle' });
  const [isGroupDetailsDialogOpen, setIsGroupDetailsDialogOpen] = useState(false);
  const [groupDetailsAnchor, setGroupDetailsAnchor] = useState<GroupManagementPopoverAnchor | null>(null);
  const [selectedParticipantSpaceId, setSelectedParticipantSpaceId] = useState<string | null>(initialSelectedParticipantSpaceId);
  const [chatChannel, setChatChannel] = useState<ChatChannel>(initialChatChannel);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const profileRows = buildCloudProfileRows(cloudAccount);
  const profileDisplayName = cloudAccount?.displayName?.trim() || cloudAccount?.primaryEmail?.trim() || 'Local profile';
  const profileAvatarSeed = cloudAccount
    ? cloudAvatarSeedForAccount(cloudAccount.accountId, cloudAccount.avatarUrl)
    : localProfileAvatarSeed || currentLocalProfileAvatarSeed;
  const profileImageUrl = cloudAccount ? cloudAvatarImageUrl(cloudAccount.avatarUrl) : null;
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

  const openCloudAccountDialog = (tab: CloudAccountSettingsTabId) => {
    setIsProfileCardOpen(false);
    setCloudAccountDialogTab(tab);
  };

  useEffect(() => {
    if (!onCheckForUpdates) return;
    let cancelled = false;
    setIsUpdateCheckPending(true);
    void onCheckForUpdates()
      .then((result) => {
        if (cancelled) return;
        setUpdateCheckResult(result.status === 'updateAvailable' ? result : null);
      })
      .catch(() => {
        if (!cancelled) setUpdateCheckResult(null);
      })
      .finally(() => {
        if (!cancelled) setIsUpdateCheckPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onCheckForUpdates]);

  const measureUpdateConfirmAnchor = () => {
    const trigger = updateButtonRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const popoverWidth = 288;
    setUpdateConfirmAnchor({
      left: Math.max(12, Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - 12)),
      top: rect.bottom + 8,
    });
  };

  useLayoutEffect(() => {
    if (!isUpdateConfirmOpen) {
      setUpdateConfirmAnchor(null);
      return;
    }
    measureUpdateConfirmAnchor();
    window.addEventListener('resize', measureUpdateConfirmAnchor);
    return () => {
      window.removeEventListener('resize', measureUpdateConfirmAnchor);
    };
  }, [isUpdateConfirmOpen]);

  const handleConfirmUpdate = async () => {
    const downloadUrl = updateCheckResult?.downloadUrl?.trim();
    if (!downloadUrl || !onInstallUpdate) {
      const fallbackUrl = updateCheckResult?.changelogUrl?.trim();
      if (fallbackUrl) await onOpenUpdateUrl?.(fallbackUrl);
      return;
    }
    setUpdateInstallState({ status: 'installing', message: 'Installing update…' });
    try {
      const result = await onInstallUpdate({ downloadUrl, version: updateCheckResult?.latestVersion ?? null });
      setUpdateInstallState({ status: 'installing', message: result.message || 'Installing update…' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to install update';
      setUpdateInstallState({ status: 'error', message });
    }
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

  // Render a participant-space session row plus, recursively, every visible
  // local fork that descends from it. Group-derived forks are filtered before
  // lineage is built, so old private group continuations do not appear as
  // nested rows, fork counts, or unread rollups.
  const ParticipantSpaceSessionRow = ({
    session,
    depth,
    seen,
  }: {
    session: ParticipantSpaceItem['sessions'][number];
    depth: number;
    seen: Set<string>;
  }) => {
    if (seen.has(session.id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(session.id);
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
    // Mirror the agent-tab tree behavior: when a parent is collapsed,
    // keep only the active session's path visible (the user shouldn't
    // lose sight of where they currently are) and hide every other
    // sibling branch.
    const visibleChildren = expanded
      ? childForks
      : childForks.filter((fork) => activeSessionPathIds.has(fork.id));
    const visualDepth = Math.min(depth, 4);
    const indentPaddingLeft = visualDepth > 0 ? `${0.625 + visualDepth * 0.875}rem` : undefined;
    return (
      <>
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
            const target = sessionContextMenuTargetForConversation(conversation, event.clientX, event.clientY);
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
              <span className="app-session-row-title app-participant-space-session-title min-w-0 flex-1 truncate text-[12px] font-medium" title={sessionRowTitle}>{sessionRowTitle}</span>
            </div>
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
        {visibleChildren.length > 0 ? (
          <div className="app-session-fork-children mt-px ml-3 space-y-px border-l border-white/[0.08] pl-2">
            {visibleChildren.map((fork) => {
              const forkRow = allSidebarSessionRowsById.get(fork.id);
              if (!forkRow) return null;
              return (
                <ParticipantSpaceSessionRow
                  key={fork.id}
                  session={forkRow.session}
                  depth={depth + 1}
                  seen={nextSeen}
                />
              );
            })}
          </div>
        ) : null}
      </>
    );
  };

  const renderParticipantSpaceItem = (space: ParticipantSpaceItem) => {
    const latestSession = space.sessions[0];
    const isDirectHuman = space.kind === 'direct-human';
    const isActiveSpace = activeParticipantSpaceId === space.id;
    const isPrimarySessionActive = Boolean(latestSession && (
      activeConvId === latestSession.id || activeConvId === latestSession.canonicalSessionId
    ));
    const isSelectedSpace = !isDirectHuman && selectedParticipantSpaceId === space.id;
    const isExpanded = !isDirectHuman && (isSelectedSpace || isActiveSpace);
    const isAutoExpanded = isExpanded && isActiveSpace && !isSelectedSpace;
    const visibleSessions = isAutoExpanded
      ? space.sessions.filter((session) => session.id === activeConvId || session.canonicalSessionId === activeConvId)
      : space.sessions;
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
              <div className={cn('app-participant-space-row-preview mt-px truncate text-[10.5px] leading-[0.98rem]', (isExpanded || (isDirectHuman && isPrimarySessionActive)) && 'app-participant-space-row-preview-active')} title={space.preview}>
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

        {isExpanded ? (
          <div className="app-participant-space-inline-sessions mt-0.5 space-y-px">
            {visibleSessions.map((session) => (
              <ParticipantSpaceSessionRow
                key={session.id}
                session={session}
                depth={0}
                seen={new Set()}
              />
            ))}
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

  const flatAgentSessions = visibleAgentParticipantSpaces
    .flatMap((space) => space.sessions.map((session) => ({ session, space })))
    .sort((left, right) => right.session.updatedAtMs - left.session.updatedAtMs
      || left.session.title.localeCompare(right.session.title));

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
  const toggleForkParent = (parentSessionId: string) => {
    setCollapsedForkParents((current) => {
      const next = new Set(current);
      if (next.has(parentSessionId)) next.delete(parentSessionId);
      else next.add(parentSessionId);
      return next;
    });
  };
  const isForkListExpanded = (parentSessionId: string) => !collapsedForkParents.has(parentSessionId);

  // The full ancestor chain of the active session, including itself.
  // Used to keep the active session always visible even when the user
  // collapses an ancestor: collapsing then only hides the *sibling*
  // sub-trees, never the active path.
  const activeSessionPathIds = useMemo(() => {
    const path = new Set<string>();
    if (!activeConvId) return path;
    let cursor: string | null = activeConvId;
    while (cursor) {
      if (path.has(cursor)) break;
      path.add(cursor);
      const parent: string | null = agentSessionRowsById.get(cursor)?.session.forkedFromSessionId ?? null;
      cursor = parent && parent.trim() ? parent : null;
    }
    return path;
  }, [activeConvId, agentSessionRowsById]);

  // No auto-expand effect needed: the recursive renderer always keeps
  // the active session's path visible even when an ancestor is
  // collapsed, so the user retains full control over collapse state
  // for sibling branches.

  // Auto-scroll the active session row into view (parent or fork) so
  // navigating to a deeply nested fork doesn't leave it off-screen.
  const agentScrollContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeConvId) return;
    const container = agentScrollContainerRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-agent-session-row="${activeConvId.replace(/"/g, '\\"')}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeConvId]);

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
            title={subtitleLine}
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

  // Render a single session row plus, recursively, every fork that
  // descends from it. The seen set guards against pathological cycles
  // that could otherwise stack-overflow if data is corrupt.
  const renderAgentSessionTreeNode = (
    row: { session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem },
    depth: number,
    seen: Set<string>,
  ): React.ReactNode => {
    if (seen.has(row.session.id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(row.session.id);
    const forks = agentForkLineage.forksByParentSessionId.get(row.session.id) ?? [];
    const expanded = forks.length === 0 ? false : isForkListExpanded(row.session.id);
    // Even when collapsed, keep showing fork branches that lead to the
    // active session so the user never loses sight of where they are.
    const childrenToRender = expanded
      ? forks
      : forks.filter((fork) => activeSessionPathIds.has(fork.id));
    const hasActiveForkPath = childrenToRender.some((fork) => activeSessionPathIds.has(fork.id));
    return (
      <div key={row.session.id} className="app-session-row-group">
        {renderAgentSessionRow(row, {
          isFork: depth > 0,
          depth,
          forkCount: forks.length,
          expanded,
          onToggleExpanded: forks.length > 0 ? () => toggleForkParent(row.session.id) : undefined,
        })}
        {childrenToRender.length > 0 ? (
          <div
            className={cn(
              'app-session-fork-children mt-px ml-3 space-y-px border-l border-white/[0.08] pl-2',
              hasActiveForkPath && 'app-session-fork-children-active',
            )}
            data-session-fork-depth={depth + 1}
            data-session-fork-path-active={hasActiveForkPath || undefined}
          >
            {childrenToRender.map((forkSession) => {
              const forkRow = agentSessionRowsById.get(forkSession.id);
              if (!forkRow) return null;
              return renderAgentSessionTreeNode(forkRow, depth + 1, nextSeen);
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderAgentSessionList = (
    rows: Array<{ session: ParticipantSpaceItem['sessions'][number]; space: ParticipantSpaceItem }>,
    emptyMessage: string,
  ) => (
    <ScrollArea
      ref={agentScrollContainerRef}
      className="app-workspace-session-scroll min-h-0 flex-1"
      data-chat-sidebar-mode="agent-sessions-flat"
    >
      <div className="w-full space-y-0.5">
        <div className="mb-1 flex justify-center px-1">
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
        {rows.length > 0 ? rows.map((row) => renderAgentSessionTreeNode(row, 0, new Set())) : (
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
            <button
              ref={profileTriggerRef}
              type="button"
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
              onClick={() => setIsProfileCardOpen((open) => !open)}
              aria-label="Open profile"
              aria-expanded={isProfileCardOpen}
            >
              <IdentityAvatar
                kind="human"
                seed={profileAvatarSeed}
                name={profileDisplayName}
                imageUrl={profileImageUrl}
                className="h-9 w-9 border border-white/10"
              />
            </button>
          </div>
        </div>

        {cloudSettings && cloudAccount && onUpdateCloudProfile ? (
          <CloudAccountSettingsDialog
            {...cloudSettings}
            isOpen={cloudAccountDialogTab !== null}
            initialTab={cloudAccountDialogTab ?? 'profile'}
            account={cloudAccount}
            localProfileAvatarSeed={localProfileAvatarSeed}
            onClose={() => setCloudAccountDialogTab(null)}
            onUpdateProfile={onUpdateCloudProfile}
            onSignOut={onCloudSignOut}
          />
        ) : null}

        {cloudSettings && cloudAccount && isProfileCardOpen && profilePopoverAnchor && typeof document !== 'undefined' ? createPortal(
          <div
            ref={profilePopoverRef}
            role="dialog"
            aria-label="Account menu"
            style={{
              position: 'fixed',
              left: profilePopoverAnchor.left,
              bottom: profilePopoverAnchor.bottom,
              zIndex: 170,
            }}
            className={cn(
              'app-popover app-profile-popover',
              'w-[22rem] rounded-[18px] border px-4 py-3 text-foreground',
            )}
          >
            <div className="mb-3 flex items-start gap-3">
              <IdentityAvatar
                kind="human"
                seed={profileAvatarSeed}
                name={profileDisplayName}
                imageUrl={profileImageUrl}
                className="h-10 w-10 border border-white/10"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-slate-100">{profileDisplayName}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-400">
                  <span className="shrink-0">Account</span>
                  <span aria-hidden="true" className="text-slate-600">•</span>
                  <span className="min-w-0 truncate font-mono" title={cloudAccount.accountId}>{cloudAccount.accountId}</span>
                  <CloudProfileRowCopyButton label="Account ID" value={cloudAccount.accountId} />
                </div>
              </div>
            </div>
            {cloudAccount.primaryEmail?.trim() ? (
              <div className="grid gap-1 text-[12px]">
                <div className="flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 transition hover:bg-white/[0.05]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-100">Email</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">{cloudAccount.primaryEmail.trim()}</div>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="mt-3 grid gap-1 border-t border-white/10 pt-3">
              <button
                type="button"
                className="app-list-item flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[12px] font-medium text-slate-100 transition hover:text-white"
                onClick={() => openCloudAccountDialog('auth')}
                aria-label="Open account settings"
              >
                <span className="flex items-center gap-2.5"><Settings className="h-4 w-4 text-slate-400" />Settings</span>
                <ChevronRightIcon className="h-4 w-4 text-slate-500" />
              </button>
            </div>
          </div>,
          document.querySelector('.bridge-app') ?? document.body,
        ) : null}

        {!cloudSettings && isProfileCardOpen && profilePopoverAnchor && typeof document !== 'undefined' ? createPortal(
          <div
            ref={profilePopoverRef}
            role="dialog"
            aria-label="Profile"
            style={{
              position: 'fixed',
              left: profilePopoverAnchor.left,
              bottom: profilePopoverAnchor.bottom,
              zIndex: 160,
            }}
            className={cn(
              'app-popover app-profile-popover',
              'w-[21.25rem] rounded-[18px] border px-4 py-3 text-foreground',
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3 text-[12px] font-medium text-slate-100">
              <span>Profile</span>
            </div>
            <div className="grid gap-1 text-[12px]">
              <div className="rounded-[12px] px-3 py-2.5 transition hover:bg-white/[0.05]">
                <div className="truncate font-medium text-slate-100">{profileDisplayName}</div>
                <div className="mt-0.5 truncate text-[11px] text-slate-400">{cloudAccount ? 'Account' : 'Local profile'}</div>
              </div>
              {profileRows.length > 0 ? profileRows.map((row) => (
                <div
                  key={row.label}
                  className="flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 transition hover:bg-white/[0.05]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-100">{row.label}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">{row.value}</div>
                  </div>
                  {row.copyable ? (
                    <CloudProfileRowCopyButton label={row.label} value={row.value} />
                  ) : null}
                </div>
              )) : (
                <div className="rounded-[12px] px-3 py-2.5 text-[12px] text-slate-400">
                  Profile details are stored locally.
                </div>
              )}
            </div>
          </div>,
          document.querySelector('.bridge-app') ?? document.body,
        ) : null}

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
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-400">
                        <span>{chatConversations.length} total</span>
                        <span aria-hidden="true">•</span>
                        <span
                          className="app-bridge-sync-status"
                          data-bridge-sync-status={bridgeSyncStatus}
                          role="status"
                          aria-live="polite"
                          aria-label={bridgeSyncAriaLabel}
                        >
                          <span className="app-bridge-sync-dot" aria-hidden="true" />
                          <span className="app-bridge-sync-label">{chatStatusLabel}</span>
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {updateCheckResult?.status === 'updateAvailable' ? (
                        <button
                          ref={updateButtonRef}
                          type="button"
                          onClick={() => {
                            measureUpdateConfirmAnchor();
                            setIsUpdateConfirmOpen((open) => !open);
                          }}
                          className={cn(
                            'app-update-logo-button app-utility-button grid h-8 w-8 place-items-center rounded-full p-0 transition',
                            'border border-slate-300/70 bg-white text-slate-950 shadow-[0_8px_18px_rgba(15,23,42,0.12)] hover:bg-slate-50',
                          )}
                          title={`Kordi ${updateCheckResult.latestVersion ?? 'update'} is available`}
                          aria-label="Check for Kordi updates"
                          aria-expanded={isUpdateConfirmOpen}
                        >
                          <RefreshCw className="h-[18px] w-[18px] stroke-[3]" aria-hidden="true" />
                        </button>
                      ) : isUpdateCheckPending ? (
                        <span className="sr-only" role="status">Checking for Kordi updates</span>
                      ) : null}
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

      {isUpdateConfirmOpen && updateConfirmAnchor && typeof document !== 'undefined' ? createPortal(
        <div
          role="dialog"
          aria-label="Confirm Kordi update"
          style={{
            position: 'fixed',
            left: updateConfirmAnchor.left,
            top: updateConfirmAnchor.top,
            zIndex: 180,
          }}
          className="app-popover w-[18rem] rounded-[18px] border px-3 py-3 text-foreground shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
        >
          <div className="text-[13px] font-semibold text-slate-100">Update available</div>
          <div className="mt-1 text-[11px] leading-5 text-slate-400">
            {updateCheckResult?.message || `Kordi ${updateCheckResult?.latestVersion} is available.`}
          </div>
          <div className="mt-2 rounded-[12px] bg-white/[0.05] px-2.5 py-2 text-[10.5px] leading-4 text-slate-300">
            {updateCheckResult?.downloadUrl
              ? 'Click Update now to download, install, and relaunch Kordi automatically.'
              : (updateCheckResult?.installCommand || 'No automatic installer is available for this release.')}
          </div>
          {updateInstallState.message ? (
            <div
              role="status"
              className={cn(
                'mt-2 rounded-[12px] px-2.5 py-2 text-[10.5px] leading-4',
                updateInstallState.status === 'error' ? 'bg-rose-500/10 text-rose-200' : 'bg-blue-500/10 text-blue-200',
              )}
            >
              {updateInstallState.message}
            </div>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-[10px] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
              onClick={() => setIsUpdateConfirmOpen(false)}
            >
              Not now
            </button>
            <button
              type="button"
              className="rounded-[10px] bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={updateInstallState.status === 'installing' || (!updateCheckResult?.downloadUrl && !updateCheckResult?.changelogUrl)}
              onClick={() => { void handleConfirmUpdate(); }}
            >
              {updateInstallState.status === 'installing' ? 'Installing…' : 'Update now'}
            </button>
          </div>
        </div>,
        document.querySelector('.bridge-app') ?? document.body,
      ) : null}

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
