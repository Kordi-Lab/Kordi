import type { Dispatch, SetStateAction } from 'react';
import {
  Activity,
  ChevronDown,
  CircleDot,
  Copy,
  Plus,
  Search,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { navAccentClasses, navItems } from '@/kordi-app/data';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import type { ChatFilter, ContactClass, NavId, SessionStatusIndicator } from '@/kordi-app/types';
import { getInitials } from '@/kordi-app/utils';
import { cn } from '@/lib/utils';

type ConversationItem = {
  id: string;
  name: string;
  subtitle: string;
  unread: number;
  messages: Array<{ time?: string }>;
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
};

type ProjectSessionItem = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  unread?: number;
  statusIndicator?: SessionStatusIndicator;
};

type ProjectItem = {
  id: string;
  name: string;
  sessions: ProjectSessionItem[];
};

type ContactGroupItem = {
  id: ContactClass;
  label: string;
};

type ContactItem = {
  id: string;
  classType: ContactClass;
};

type AgentItem = {
  id: string;
  name: string;
  status: string;
  role: string;
  messaging: string;
  tasks: number;
};

type BridgeHostSummary = {
  serverUrl: string;
  connected: boolean;
  nodeId?: string | null;
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
  chatFilter: ChatFilter;
  setChatFilter: Dispatch<SetStateAction<ChatFilter>>;
  isDesktopChatLoading: boolean;
  desktopChatError: string | null;
  filteredConversations: ConversationItem[];
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
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
  onRefreshBridge: () => void;
  onCopyBridgeHostUrl: () => void;
  onCreateBridgeDraft: () => void;
};

function SidebarSessionStatusIndicator({
  indicator,
  active = false,
}: {
  indicator?: SessionStatusIndicator;
  active?: boolean;
}) {
  if (!indicator) return null;

  const toneClasses =
    indicator.tone === 'running'
      ? {
          glow: active ? 'bg-sky-300/35' : 'bg-sky-400/26',
          dot: active ? 'bg-sky-200 ring-sky-200/45' : 'bg-sky-300 ring-sky-300/35',
        }
      : indicator.tone === 'draft'
        ? {
            glow: active ? 'bg-amber-300/28' : 'bg-amber-400/18',
            dot: active ? 'bg-amber-200 ring-amber-200/35' : 'bg-amber-300 ring-amber-300/25',
          }
        : indicator.tone === 'error'
          ? {
              glow: active ? 'bg-rose-300/30' : 'bg-rose-400/20',
              dot: active ? 'bg-rose-200 ring-rose-200/40' : 'bg-rose-300 ring-rose-300/30',
            }
          : indicator.tone === 'stopped'
            ? {
                glow: active ? 'bg-slate-200/18' : 'bg-white/10',
                dot: active ? 'bg-slate-200 ring-slate-200/30' : 'bg-slate-300 ring-slate-300/18',
              }
            : {
                glow: active ? 'bg-emerald-300/26' : 'bg-emerald-400/18',
                dot: active ? 'bg-emerald-200 ring-emerald-200/38' : 'bg-emerald-300 ring-emerald-300/24',
              };

  return (
    <span
      className="relative inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      title={indicator.label}
      aria-label={indicator.label}
    >
      <span className={cn('absolute inset-[-4px] rounded-full blur-[4px]', toneClasses.glow)} />
      {indicator.live ? (
        <span className={cn('absolute inset-[-1px] rounded-full opacity-60 motion-safe:animate-ping motion-reduce:animate-none', toneClasses.glow)} />
      ) : null}
      <span className={cn('relative h-2.5 w-2.5 rounded-full ring-1', toneClasses.dot)} />
    </span>
  );
}

function SidebarUnreadBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null;

  return (
    <span className="inline-flex min-w-[1.05rem] shrink-0 items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.18)]">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function SidebarSessionMetaColumn({
  timeLabel,
  unreadCount,
  indicator,
  active = false,
}: {
  timeLabel: string;
  unreadCount?: number;
  indicator?: SessionStatusIndicator;
  active?: boolean;
}) {
  return (
    <div className="flex w-[3.85rem] shrink-0 flex-col items-end gap-[0.3rem] pt-px">
      <span className={cn('block w-full text-right text-[10px] font-medium leading-none tabular-nums tracking-[0.03em]', active ? 'text-slate-300' : 'text-slate-500')}>
        {timeLabel}
      </span>
      <div className="flex h-2.5 w-full items-center justify-end gap-1.5">
        <SidebarUnreadBadge count={unreadCount} />
        <SidebarSessionStatusIndicator indicator={indicator} active={active} />
      </div>
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
  chatSearch,
  setChatSearch,
  chatFilter,
  setChatFilter,
  isDesktopChatLoading,
  desktopChatError,
  filteredConversations,
  activeConvId,
  onSelectChatSession,
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
  onRefreshBridge,
  onCopyBridgeHostUrl,
  onCreateBridgeDraft,
}: WorkspaceSidebarProps) {
  const totalUnread = chatConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread ?? 0), 0);
  const formatUnreadCount = (value: number) => (value > 99 ? '99+' : `${value}`);

  return (
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
          <div className="flex w-full flex-col items-center gap-3">
            {!isNativeShell && (
              <div className="flex items-center justify-center gap-2 pt-1">
                <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
              </div>
            )}
            <div className="flex w-full flex-col items-center gap-1.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveNav(item.id)}
                    className={`app-workspace-nav-button relative grid h-10 w-10 place-items-center rounded-full transition ${
                      active
                        ? 'bg-transparent shadow-none'
                        : 'text-slate-300 hover:bg-transparent'
                    }`}
                  >
                    <Icon className={cn('h-[18px] w-[18px]', active ? navAccentClasses[item.id] : 'text-slate-300')} />
                    {item.id === 'chats' && totalUnread > 0 ? (
                      <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-white px-1 py-[0.1rem] text-[8px] font-semibold leading-none text-slate-950 shadow-[0_0_0_1px_rgba(15,23,42,0.55)]">
                        {formatUnreadCount(totalUnread)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex w-full flex-col items-center gap-2">
            <Button size="icon" className="h-10 w-10 rounded-xl">
              <Plus className="h-4 w-4" />
            </Button>
            <Avatar className="h-10 w-10 border border-white/10">
              <AvatarFallback className="bg-slate-800 text-[12px] text-slate-100">CC</AvatarFallback>
            </Avatar>
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
                  <div className="mb-2.5 flex items-start justify-between gap-2.5">
                    <div>
                      <div className="text-[15px] font-semibold text-white">{chatConversations.length} sessions</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {totalUnread > 0 ? `${formatUnreadCount(totalUnread)} unread updates` : 'Everything read'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onCreateChatSession}
                      className="app-icon-button app-utility-button flex h-8 w-8 items-center justify-center rounded-[12px] text-slate-200"
                      title="New chat session"
                      aria-label="New chat session"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="app-side-note app-workspace-note mb-2.5 rounded-[14px] p-2.5 text-[11px] text-slate-300">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-100">
                      <CircleDot className="h-2.5 w-2.5" />
                      All your sessions stay here
                    </div>
                    <div className="text-[11px] leading-4.5 text-slate-500">People, owned agents, and delegated agent sessions in one place.</div>
                  </div>

                  <div className="app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 text-slate-400" />
                    <input
                      value={chatSearch}
                      onChange={(event) => setChatSearch(event.target.value)}
                      placeholder="Search sessions"
                      className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
                    />
                  </div>

                  <div className="mb-2 space-y-1.5">
                    <div className="app-filter-tabs">
                      {[
                        { id: 'all', label: 'All' },
                        { id: 'people', label: 'People' },
                        { id: 'agents', label: 'Agents' },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setChatFilter(tab.id as ChatFilter)}
                          className={chatFilter === tab.id ? 'app-filter-tab app-filter-tab-active' : 'app-filter-tab'}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {isDesktopChatLoading ? (
                    <div className="mb-2 rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-slate-300">
                      Loading real chat sessions…
                    </div>
                  ) : null}
                  {desktopChatError ? (
                    <div className="mb-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
                      {desktopChatError}
                    </div>
                  ) : null}

                  <ScrollArea className="min-h-0 flex-1 pr-1">
                    <div className="space-y-1">
                      {filteredConversations.map((conversation) => {
                        const lastMessage = conversation.messages[conversation.messages.length - 1];
                        const isActive = activeConvId === conversation.id;
                        const rowTimeLabel = conversation.updatedAtLabel ?? lastMessage?.time ?? '--:--';

                        return (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => onSelectChatSession(conversation.id)}
                            className={`app-session-row w-full px-2.5 py-[0.3125rem] text-left ${
                              isActive ? 'app-session-row-active text-white' : 'text-white'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <Avatar className="mt-px h-7 w-7 border border-white/10">
                                <AvatarFallback className={isActive ? 'bg-[#e7e1d8] text-[#201d1a]' : 'bg-white/[0.045] text-slate-200'}>
                                  {getInitials(conversation.name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1 pr-1">
                                    <div className="truncate text-[12px] font-medium text-slate-100">{conversation.name}</div>
                                    {conversation.subtitle.trim().length > 0 ? (
                                      <div className={cn('mt-px truncate text-[11px] leading-[1.05rem]', isActive ? 'text-slate-300' : 'text-slate-500')}>
                                        {conversation.subtitle}
                                      </div>
                                    ) : null}
                                  </div>
                                  <SidebarSessionMetaColumn
                                    timeLabel={rowTimeLabel}
                                    unreadCount={conversation.unread}
                                    indicator={conversation.statusIndicator}
                                    active={isActive}
                                  />
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {activeNav === 'projects' && (
                <div className="flex h-full flex-col p-2.5 text-white">
                  <div className="mb-2.5 flex items-start justify-between gap-2.5">
                    <div>
                      <div className="text-xs text-slate-400">Project spaces</div>
                      <div className="text-[15px] font-semibold text-white">{runtimeProjects.length} projects</div>
                    </div>
                    <Button size="icon" variant="secondary" className="app-icon-button h-8 w-8 rounded-lg border-0">
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

                  <ScrollArea className="min-h-0 flex-1 pr-1">
                    <div className="space-y-1.5">
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
                                          'app-project-session-row w-full min-w-0 rounded-[12px] border border-transparent px-2.5 py-[0.3125rem] text-left transition',
                                          isActiveSession
                                            ? 'border-white/10 bg-white/[0.055] text-white'
                                            : 'text-slate-300 hover:bg-white/[0.025] hover:text-white',
                                        )}
                                      >
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0 flex-1 pr-1">
                                            <div className="truncate text-[12px] font-medium">{session.name}</div>
                                            {session.summary.trim().length > 0 ? (
                                              <div className={cn('mt-px truncate text-[11px] leading-[1.05rem]', isActiveSession ? 'text-slate-300' : 'text-slate-500')}>
                                                {session.summary}
                                              </div>
                                            ) : null}
                                          </div>
                                          <SidebarSessionMetaColumn
                                            timeLabel={session.lastActive}
                                            unreadCount={session.unread}
                                            indicator={session.statusIndicator}
                                            active={isActiveSession}
                                          />
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
                              <div>
                                <div className="font-medium">{agent.name}</div>
                                <div className="text-xs text-slate-400">{agent.id}</div>
                              </div>
                              <Badge variant="outline" className="border-white/20 text-slate-200">
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
  );
}
