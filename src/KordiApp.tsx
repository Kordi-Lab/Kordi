import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  ArrowRightLeft,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FolderOpen,
  Globe,
  Info,
  KeyRound,
  Layers3,
  Link2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  agents,
  contactGroups,
  contactRequests,
  contacts,
  conversations,
  navAccentClasses,
  navItems,
  projects,
  settingsSections,
} from '@/kordi-app/data';
import {
  clampDetailPanelWidth,
  clampSessionPanelWidth,
  clampWindowSize,
  getInitialWindowSize,
  WINDOW_DEFAULT_WIDTH,
} from '@/kordi-app/layout';
import {
  BridgeChip,
  ComposerModeControl,
  ComposerModelControls,
  MessageBubble,
  SettingsValueControl,
  StatusPill,
  TypeBadge,
} from '@/kordi-app/components';
import { AgentsPage, ContactsPage } from '@/kordi-app/pages';
import type {
  ChatFilter,
  ComposerScope,
  ComposerSelectorType,
  ContactClass,
  DetailTab,
  EditFilePreview,
  NavId,
  PanelResizeTarget,
  ResizeDirection,
  ThemeMode,
} from '@/kordi-app/types';
import { getContactSortLetter, getInitials } from '@/kordi-app/utils';

export default function KordiApp() {
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const panelResizeStateRef = useRef<{
    target: PanelResizeTarget;
    startX: number;
    startWidth: number;
  } | null>(null);
  const windowWidthRef = useRef(WINDOW_DEFAULT_WIDTH);
  const leftWorkspaceWidthRef = useRef(64);
  const rightDetailVisibleRef = useRef(false);
  const [activeNav, setActiveNav] = useState<NavId>('chats');
  const [activeConvId, setActiveConvId] = useState('my-agent');
  const [activeContactGroup, setActiveContactGroup] = useState<ContactClass>('my-agents');
  const [activeContactId, setActiveContactId] = useState('my-core-agent');
  const [isSessionPanelCollapsed, setIsSessionPanelCollapsed] = useState(false);
  const [isDetailPanelCollapsed, setIsDetailPanelCollapsed] = useState(false);
  const [isContactRequestsOpen, setIsContactRequestsOpen] = useState(false);
  const [activeContactRequestId, setActiveContactRequestId] = useState(contactRequests[0]?.id ?? '');
  const [contactOverlayMode, setContactOverlayMode] = useState<'contact' | 'request' | null>(null);
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id ?? '');
  const [isAgentOverlayOpen, setIsAgentOverlayOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState(projects[0]?.id ?? '');
  const [activeProjectSessionId, setActiveProjectSessionId] = useState(projects[0]?.sessions[0]?.id ?? '');
  const [activeSettingsSectionId, setActiveSettingsSectionId] = useState<(typeof settingsSections)[number]['id']>('general');
  const [activeSourcePreview, setActiveSourcePreview] = useState<EditFilePreview | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
  const [composerSelections, setComposerSelections] = useState<Record<ComposerScope, { mode: string; model: string; thinking: string }>>({
    chat: { mode: 'Send as Me', model: 'GPT-5.4', thinking: 'Extra High' },
    project: { mode: 'Post update', model: 'GPT-5.4', thinking: 'High' },
  });
  const [composerDrafts, setComposerDrafts] = useState<Record<ComposerScope, string>>({
    chat: '',
    project: '',
  });
  const [openComposerSelector, setOpenComposerSelector] = useState<{ scope: ComposerScope; type: ComposerSelectorType } | null>(null);
  const [windowSize, setWindowSize] = useState(getInitialWindowSize);
  const [sessionRailUserWidth, setSessionRailUserWidth] = useState(272);
  const [detailRailUserWidth, setDetailRailUserWidth] = useState(340);
  const [isLayoutResizing, setIsLayoutResizing] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [expandedContactGroups, setExpandedContactGroups] = useState<Record<ContactClass, boolean>>({
    'my-agents': true,
    'other-users-agents': false,
    'other-users': false,
  });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({
    [projects[0]?.id ?? '']: true,
  });
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const [chatSearch, setChatSearch] = useState('');
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('info');

  const activeConv = useMemo(() => conversations.find((c) => c.id === activeConvId) ?? conversations[0], [activeConvId]);
  const activeLastMessage = activeConv.messages[activeConv.messages.length - 1];
  const filteredConversations = useMemo(() => {
    const normalizedSearch = chatSearch.trim().toLowerCase();

    return conversations.filter((conversation) => {
      const matchesFilter =
        chatFilter === 'all'
          ? true
          : chatFilter === 'people'
            ? conversation.type === 'person'
            : chatFilter === 'agents'
              ? conversation.type !== 'person'
              : conversation.directness !== 'Direct chat';

      const matchesSearch =
        normalizedSearch.length === 0
          ? true
          : [conversation.name, conversation.subtitle, conversation.participants.join(' '), conversation.messages[conversation.messages.length - 1]?.text]
              .filter(Boolean)
              .some((value) => value.toLowerCase().includes(normalizedSearch));

      return matchesFilter && matchesSearch;
    });
  }, [chatFilter, chatSearch]);
  const groupedContacts = useMemo(
    () =>
      contactGroups.map((group) => ({
        ...group,
        items: contacts.filter((contact) => contact.classType === group.id).sort((a, b) => a.name.localeCompare(b.name)),
      })),
    [],
  );
  const filteredGroupedContacts = useMemo(() => {
    const normalizedSearch = contactSearch.trim().toLowerCase();

    return groupedContacts.map((group) => ({
      ...group,
      items:
        normalizedSearch.length === 0
          ? group.items
          : group.items.filter((contact) =>
              [contact.name, contact.entityType, contact.subtitle, contact.detail]
                .filter(Boolean)
                .some((value) => value.toLowerCase().includes(normalizedSearch)),
            ),
    }));
  }, [contactSearch, groupedContacts]);
  const activeContact = contacts.find((contact) => contact.id === activeContactId) ?? contacts[0];
  const activeContactRequest = contactRequests.find((request) => request.id === activeContactRequestId) ?? contactRequests[0];
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const filteredProjects = useMemo(() => {
    const normalizedSearch = projectSearch.trim().toLowerCase();

    return projects.filter((project) => {
      if (normalizedSearch.length === 0) return true;

      return [project.name, project.summary, project.scope, ...project.sessions.map((session) => session.name)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [projectSearch]);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const activeProjectSession =
    activeProject.sessions.find((session) => session.id === activeProjectSessionId) ?? activeProject.sessions[0];
  const activeProjectLastMessage = activeProjectSession.messages[activeProjectSession.messages.length - 1];
  const activeSettingsSection = settingsSections.find((section) => section.id === activeSettingsSectionId) ?? settingsSections[0];
  const rootThemeClass = themeMode === 'light' ? 'theme-light' : 'theme-dark';
  const detailTabs: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'info', label: 'Info', icon: Info },
    { id: 'context', label: 'Context', icon: Layers3 },
    { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
    { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
  ];
  const showSessionRail = activeNav === 'chats' || activeNav === 'projects';
  const showRightDetailRail = activeNav === 'chats' || activeNav === 'projects';
  const showChatDetailRail = activeNav === 'chats';
  const collapseChatSessions = showSessionRail && isSessionPanelCollapsed;
  const isSingleWorkspacePage = activeNav !== 'chats' && activeNav !== 'projects';
  const sessionRailWidth =
    showSessionRail && !collapseChatSessions
      ? clampSessionPanelWidth(sessionRailUserWidth, windowSize.width, showRightDetailRail && !isDetailPanelCollapsed)
      : 0;
  const leftWorkspaceWidth = collapseChatSessions || isSingleWorkspacePage ? 64 : 64 + sessionRailWidth;
  const detailRailWidth =
    showRightDetailRail && !isDetailPanelCollapsed
      ? clampDetailPanelWidth(detailRailUserWidth, windowSize.width, leftWorkspaceWidth)
      : 0;
  const settingsRailWidth = Math.max(240, Math.min(272, Math.round(windowSize.width * 0.18)));

  useEffect(() => {
    windowWidthRef.current = windowSize.width;
    leftWorkspaceWidthRef.current = leftWorkspaceWidth;
    rightDetailVisibleRef.current = showRightDetailRail && !isDetailPanelCollapsed;
  }, [windowSize.width, leftWorkspaceWidth, showRightDetailRail, isDetailPanelCollapsed]);

  useEffect(() => {
    setActiveSourcePreview(null);
    setOpenComposerSelector(null);
  }, [activeNav, activeConvId, activeProjectId, activeProjectSessionId]);

  useEffect(() => {
    if (!openComposerSelector) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (composerControlsRef.current?.contains(event.target as Node)) return;
      setOpenComposerSelector(null);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [openComposerSelector]);

  useEffect(() => {
    document.body.classList.toggle('theme-light', themeMode === 'light');
    document.body.classList.toggle('theme-dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;

    return () => {
      document.body.classList.remove('theme-light', 'theme-dark');
      document.documentElement.style.colorScheme = 'dark';
    };
  }, [themeMode]);

  useEffect(() => {
    const handleWindowResize = () => {
      setWindowSize((current) => clampWindowSize(current.width, current.height));
    };

    const handlePointerMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current;
      if (resizeState) {
        let nextWidth = resizeState.startWidth;
        let nextHeight = resizeState.startHeight;
        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;

        if (resizeState.direction === 'right' || resizeState.direction === 'top-right' || resizeState.direction === 'bottom-right') {
          nextWidth = resizeState.startWidth + deltaX;
        }

        if (resizeState.direction === 'left' || resizeState.direction === 'top-left' || resizeState.direction === 'bottom-left') {
          nextWidth = resizeState.startWidth - deltaX;
        }

        if (resizeState.direction === 'bottom' || resizeState.direction === 'bottom-left' || resizeState.direction === 'bottom-right') {
          nextHeight = resizeState.startHeight + deltaY;
        }

        if (resizeState.direction === 'top' || resizeState.direction === 'top-left' || resizeState.direction === 'top-right') {
          nextHeight = resizeState.startHeight - deltaY;
        }

        setWindowSize(clampWindowSize(nextWidth, nextHeight));
      }

      const panelResizeState = panelResizeStateRef.current;
      if (panelResizeState) {
        const deltaX = event.clientX - panelResizeState.startX;

        if (panelResizeState.target === 'session') {
          setSessionRailUserWidth(
            clampSessionPanelWidth(
              panelResizeState.startWidth + deltaX,
              windowWidthRef.current,
              rightDetailVisibleRef.current,
            ),
          );
        }

        if (panelResizeState.target === 'detail') {
          setDetailRailUserWidth(clampDetailPanelWidth(panelResizeState.startWidth - deltaX, windowWidthRef.current, leftWorkspaceWidthRef.current));
        }
      }
    };

    const stopResize = () => {
      const hadWindowResize = Boolean(resizeStateRef.current);
      const hadPanelResize = Boolean(panelResizeStateRef.current);
      if (!hadWindowResize && !hadPanelResize) return;

      resizeStateRef.current = null;
      panelResizeStateRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setIsLayoutResizing(false);
    };

    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', stopResize);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const startWindowResize =
    (direction: ResizeDirection) => (event: React.MouseEvent<HTMLDivElement | HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        direction,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: windowSize.width,
        startHeight: windowSize.height,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor =
        direction === 'left' || direction === 'right'
          ? 'ew-resize'
          : direction === 'top' || direction === 'bottom'
            ? 'ns-resize'
            : direction === 'top-left' || direction === 'bottom-right'
              ? 'nwse-resize'
              : 'nesw-resize';
      setIsLayoutResizing(true);
    };

  const startPanelResize =
    (target: PanelResizeTarget) => (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      panelResizeStateRef.current = {
        target,
        startX: event.clientX,
        startWidth: target === 'session' ? sessionRailWidth : detailRailWidth,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
      setIsLayoutResizing(true);
    };

  const toggleComposerSelector = (scope: ComposerScope, type: ComposerSelectorType) => {
    setOpenComposerSelector((current) => (current?.scope === scope && current.type === type ? null : { scope, type }));
  };

  const selectComposerValue = (scope: ComposerScope, type: ComposerSelectorType, value: string) => {
    setComposerSelections((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        [type]: value,
      },
    }));
    setOpenComposerSelector(null);
  };

  const updateComposerDraft = (scope: ComposerScope, value: string, target: HTMLTextAreaElement) => {
    setComposerDrafts((current) => ({
      ...current,
      [scope]: value,
    }));

    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  };

  const getStatusBadgeClass = (value: string) => {
    const normalized = value.toLowerCase();

    if (normalized.includes('owned')) return 'app-badge-owned';
    if (normalized.includes('pending') || normalized.includes('approval')) return 'app-badge-attention';
    return 'app-badge-neutral';
  };

  return (
    <div className={cn('bridge-app app-page-bg min-h-screen p-4 text-[13px] text-foreground md:p-6', rootThemeClass)}>
      <div
        className="app-shell relative mx-auto flex flex-col overflow-hidden rounded-[26px] border shadow-[var(--app-shadow-float)] backdrop-blur-2xl"
        style={{ width: `${windowSize.width}px`, height: `${windowSize.height}px` }}
      >
        <div
          className={cn(
            'relative grid h-full flex-1 gap-0 overflow-hidden',
            isLayoutResizing ? 'transition-none' : 'transition-[grid-template-columns]',
          )}
          style={{
            gridTemplateColumns: `${leftWorkspaceWidth}px minmax(0, 1fr)`,
          }}
        >
        <aside className={cn('app-side-shell overflow-hidden', isSingleWorkspacePage ? 'rounded-none' : 'rounded-bl-[22px] rounded-r-none')}>
          <div className="flex h-full">
            <div
              className={cn(
                'app-left-glass flex w-[64px] shrink-0 flex-col items-center justify-between p-2.5',
                collapseChatSessions || isSingleWorkspacePage ? '' : 'shadow-[inset_-1px_0_0_rgba(255,255,255,0.05)]',
              )}
            >
              <div className="flex w-full flex-col items-center gap-3">
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                    <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                    <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]" />
                  </div>
                  <div className="flex w-full flex-col items-center gap-1.5">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    const active = activeNav === item.id;
                    return (
	                      <button
	                        key={item.id}
	                        onClick={() => setActiveNav(item.id)}
	                        className={`grid h-10 w-10 place-items-center rounded-full transition ${
	                          active
	                            ? 'bg-transparent shadow-none'
	                            : 'text-slate-300 hover:bg-transparent'
	                        }`}
	                      >
	                        <Icon className={cn('h-[18px] w-[18px]', active ? navAccentClasses[item.id] : 'text-slate-300')} />
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
            <div className="app-session-panel overflow-hidden" style={{ width: `${sessionRailWidth}px` }}>
              <div className="h-full overflow-hidden">
            {activeNav === 'chats' && (
                <div className="flex h-full flex-col p-2.5">
                  <div className="mb-2.5 flex items-start justify-between gap-2.5">
                    <div>
                      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Started sessions</div>
                      <div className="mt-1 text-[15px] font-semibold text-white">{conversations.length} threads</div>
                    </div>
                    <div className="app-icon-button app-utility-button flex h-8 w-8 items-center justify-center rounded-[12px] text-slate-200">
                      <Bell className="h-3.5 w-3.5" />
                    </div>
                  </div>

                  <div className="app-side-note mb-2.5 rounded-[16px] p-2.5 text-[11px] text-slate-300">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-100">
                      <CircleDot className="h-2.5 w-2.5" />
                      All your threads stay here
                    </div>
                    <div className="text-[10px] leading-4.5 text-slate-500">People, owned agents, and delegated agent sessions in one place.</div>
                  </div>

                  <div className="app-input-shell mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
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
                    <button
                      type="button"
                      onClick={() => setChatFilter('delegated')}
                      className={chatFilter === 'delegated' ? 'app-filter-toggle app-filter-toggle-active' : 'app-filter-toggle'}
                    >
                      Delegated only
                    </button>
                  </div>

                  <ScrollArea className="min-h-0 flex-1 pr-1">
                    <div className="space-y-1">
                      {filteredConversations.map((conversation) => {
                        const lastMessage = conversation.messages[conversation.messages.length - 1];
                        const isActive = activeConvId === conversation.id;

                        return (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => setActiveConvId(conversation.id)}
                            className={`app-session-row w-full px-2.5 py-2 text-left ${
                              isActive ? 'app-session-row-active text-white' : 'text-white'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <Avatar className="h-8 w-8 border border-white/10">
                                <AvatarFallback className={isActive ? 'bg-[#e7e1d8] text-[#201d1a]' : 'bg-white/[0.045] text-slate-200'}>
                                  {getInitials(conversation.name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div className="mb-0.5 flex items-center justify-between gap-2">
                                  <div className="truncate text-[12px] font-medium text-slate-100">{conversation.name}</div>
                                  <div className="flex items-center gap-1.5">
                                    {conversation.unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-slate-100/90" />}
                                    <span className="text-[9px] text-slate-500">{lastMessage?.time}</span>
                                  </div>
                                </div>
                                <div className={`truncate text-[10px] ${isActive ? 'text-slate-300' : 'text-slate-500'}`}>
                                  {conversation.subtitle}
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
                      <div className="text-[15px] font-semibold text-white">{projects.length} projects</div>
                    </div>
                    <Button size="icon" variant="secondary" className="app-icon-button h-8 w-8 rounded-lg border-0">
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="app-input-shell mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
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
                        const isActiveProject = activeProject.id === project.id;
                        const isExpanded = expandedProjectIds[project.id] ?? false;

                        return (
                          <div key={project.id} className="app-surface-card rounded-[20px]">
                            <button
                              type="button"
                              onClick={() => {
                                setActiveProjectId(project.id);
                                setActiveProjectSessionId(project.sessions[0]?.id ?? '');
                                setExpandedProjectIds((current) => ({
                                  ...current,
                                  [project.id]: current[project.id] === undefined ? true : !current[project.id],
                                }));
                              }}
                              className={cn(
                                'flex w-full items-center justify-between gap-2 rounded-[20px] px-3 py-3 text-left transition',
                                isActiveProject ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]',
                              )}
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-medium text-white">{project.name}</div>
                                <div className="mt-0.5 text-[11px] text-slate-400">{project.sessions.length} sessions</div>
                              </div>
                              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', isExpanded ? 'rotate-180' : '')} />
                            </button>

                            {isExpanded && (
                              <div className="px-2 pb-2">
                                <div className="app-surface-muted space-y-1 rounded-[18px] p-1.5">
                                  {project.sessions.map((session) => {
                                    const isActiveSession =
                                      activeProject.id === project.id && activeProjectSession.id === session.id;

                                    return (
                                      <button
                                        key={session.id}
                                        type="button"
                                        onClick={() => {
                                          setActiveProjectId(project.id);
                                          setActiveProjectSessionId(session.id);
                                        }}
                                        className={cn(
                                          'w-full rounded-[16px] px-3 py-2 text-left transition',
                                          isActiveSession ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                                        )}
                                      >
                                        <div className="truncate text-[12px] font-medium">{session.name}</div>
                                        <div className="mt-0.5 truncate text-[10px] text-slate-400">{session.lastActive}</div>
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
                    {contactGroups.map((group) => (
                      <button
                        key={group.id}
                        onClick={() => {
                          setActiveContactGroup(group.id);
                          const first = contacts.find((contact) => contact.classType === group.id);
                          if (first) setActiveContactId(first.id);
                        }}
                        className={`flex items-center justify-between rounded-xl px-3 py-2 text-left transition ${
                          activeContactGroup === group.id
                            ? 'bg-white/12 text-white ring-1 ring-white/15'
                            : 'bg-white/5 text-white hover:bg-white/10'
                        }`}
                      >
                        <span className="text-sm font-medium">{group.label}</span>
                        <Badge
                          variant={activeContactGroup === group.id ? 'secondary' : 'outline'}
                          className={`rounded-full ${activeContactGroup === group.id ? 'text-slate-950' : 'text-slate-200 border-white/15'}`}
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
                        <div className="text-sm text-slate-400">My agents</div>
                        <div className="text-xl font-semibold text-white">4 active identities</div>
                      </div>
                      <Button className="rounded-xl">
                        <Plus className="mr-2 h-4 w-4" />New
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {agents.map((agent) => (
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
                  <div className="space-y-3 text-white">
                    <Card className="rounded-3xl border-white/10 bg-white/5 shadow-none">
                      <CardHeader>
                        <CardTitle className="text-base">Your bridge membership</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm text-slate-300">
                        <div className="flex items-center justify-between">
                          <span>Joined bridges</span>
                          <span>3</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Discovery mode</span>
                          <span>Cross-bridge</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Reachable peers</span>
                          <span>24</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Recent failures</span>
                          <span>1 retry</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-3xl border-white/10 bg-white/5 shadow-none">
                      <CardHeader>
                        <CardTitle className="text-base">Quick actions</CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-2">
                        <Button variant="secondary" className="justify-start rounded-xl">
                          <KeyRound className="mr-2 h-4 w-4" /> Export identity
                        </Button>
                        <Button variant="secondary" className="justify-start rounded-xl">
                          <Link2 className="mr-2 h-4 w-4" /> Join another bridge
                        </Button>
                        <Button variant="secondary" className="justify-start rounded-xl">
                          <Activity className="mr-2 h-4 w-4" /> View route logs
                        </Button>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              )}

            {activeNav === 'settings' && (
                <div className="h-full p-3">
                  <div className="space-y-3 text-white">
                    {['Profile', 'Notifications', 'Appearance', 'Privacy', 'Developer'].map((section) => (
                      <Card key={section} className="rounded-3xl border-white/10 bg-white/5 shadow-none">
                        <CardContent className="flex items-center justify-between p-4">
                          <div>
                            <div className="font-medium">{section}</div>
                            <div className="text-xs text-slate-400">Open {section.toLowerCase()} settings</div>
                          </div>
                          <ChevronDown className="h-4 w-4 text-slate-400" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
              </div>
            </div>
            )}
          </div>
        </aside>
        {showSessionRail && !collapseChatSessions && (
          <div
            onMouseDown={startPanelResize('session')}
            className="absolute bottom-0 top-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${leftWorkspaceWidth}px` }}
            aria-hidden="true"
          >
            <div className="mx-auto h-full w-px bg-white/8 transition hover:bg-white/20" />
          </div>
        )}

        <section
          className={cn(
            'relative overflow-hidden',
            isSingleWorkspacePage ? 'app-main-panel rounded-none border-0' : 'app-main-panel rounded-br-[22px] rounded-l-none border-l border-white/10',
          )}
        >
          <div
            className={cn(
              'grid h-full',
              isLayoutResizing ? 'transition-none' : 'transition-[grid-template-columns] duration-300',
            )}
            style={{ gridTemplateColumns: showRightDetailRail && !isDetailPanelCollapsed ? `minmax(0, 1fr) ${detailRailWidth}px` : 'minmax(0, 1fr)' }}
          >
        <main className="flex min-h-0 min-w-0 overflow-hidden">
          {activeNav === 'contacts' ? (
            <ContactsPage
              filteredGroupedContacts={filteredGroupedContacts}
              isContactRequestsOpen={isContactRequestsOpen}
              onToggleRequests={() => setIsContactRequestsOpen((open) => !open)}
              contactRequests={contactRequests}
              activeContactRequestId={activeContactRequestId}
              onReviewRequest={(requestId) => {
                setActiveContactRequestId(requestId);
                setContactOverlayMode('request');
              }}
              contactSearch={contactSearch}
              onContactSearchChange={setContactSearch}
              expandedContactGroups={expandedContactGroups}
              onToggleGroup={(groupId) =>
                setExpandedContactGroups((current) => ({
                  ...current,
                  [groupId]: !current[groupId],
                }))
              }
              activeContactId={activeContactId}
              onSelectContact={(groupId, contactId) => {
                setActiveContactGroup(groupId);
                setActiveContactId(contactId);
                setContactOverlayMode('contact');
              }}
              contactOverlayMode={contactOverlayMode}
              activeContact={activeContact}
              activeContactRequest={activeContactRequest}
              onCloseOverlay={() => setContactOverlayMode(null)}
              getStatusBadgeClass={getStatusBadgeClass}
            />
          ) : activeNav === 'projects' ? (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <div className="shrink-0 flex items-center justify-between px-4 py-3 shadow-[inset_0_-1px_0_var(--app-divider)]">
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
                    className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] text-slate-100 transition"
                    aria-label={collapseChatSessions ? 'Open project panel' : 'Close project panel'}
                    title={collapseChatSessions ? 'Open project panel' : 'Close project panel'}
                  >
                    {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
                  </button>
                  <div>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-white">
                      <h2 className="text-lg font-semibold">{activeProjectSession.name}</h2>
                      <Badge variant="outline" className="rounded-full border-white/15 text-[10px] text-slate-200">
                        {activeProject.status}
                      </Badge>
                    </div>
                    <div className="mb-2 text-[13px] text-slate-300">{activeProject.name}</div>
                    <div className="flex flex-wrap gap-2 text-xs text-slate-200">
                      <StatusPill>
                        <Globe className="h-3 w-3" /> {activeProject.bridge}
                      </StatusPill>
                      <StatusPill>
                        <Users className="h-3 w-3" /> {activeProject.people.length + activeProject.agents.length} members
                      </StatusPill>
                      <StatusPill>
                        <Layers3 className="h-3 w-3" /> {activeProject.sessions.length} sessions
                      </StatusPill>
                      <StatusPill>
                        <FolderOpen className="h-3 w-3" /> {activeProject.artifacts} artifacts
                      </StatusPill>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {showRightDetailRail && (
                    <button
                      type="button"
                      onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
                      className="app-icon-button app-utility-button grid h-7.5 w-7.5 place-items-center rounded-[12px] text-slate-100 transition"
                      aria-label={isDetailPanelCollapsed ? 'Open project detail panel' : 'Close project detail panel'}
                      title={isDetailPanelCollapsed ? 'Open project detail panel' : 'Close project detail panel'}
                    >
                      <span className="translate-y-[-1px] text-[16px] font-medium leading-none tracking-[0.08em]">...</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="shrink-0 px-4 pt-3">
                <div className="app-surface-card rounded-[26px] px-4 py-3 text-white">
                  <div className="text-[13px] leading-5 text-slate-300">{activeProject.summary}</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <div className="app-control-chip rounded-full px-3 py-1 text-[11px] text-slate-200">
                      Pending invites: {activeProject.pendingInvites.length}
                    </div>
                    {activeProject.pendingInvites.map((invite) => (
                      <div key={invite} className="app-control-chip rounded-full px-3 py-1 text-[11px] text-slate-300">
                        {invite}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1 px-4 py-3">
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
                  {activeProjectSession.messages.map((msg, idx) => (
                    <MessageBubble
                      key={`${activeProjectSession.id}-${msg.time}-${idx}`}
                      msg={msg}
                      onOpenSource={(file) => {
                        setActiveSourcePreview(file);
                        setIsDetailPanelCollapsed(false);
                      }}
                    />
                  ))}
                </motion.div>
              </ScrollArea>

              <div className="shrink-0 px-4 pb-3">
                <div className="app-composer-shell rounded-[26px] p-3">
                  <div className="app-composer-input rounded-[18px] px-4 py-2.5 transition">
                    <textarea
                      rows={1}
                      value={composerDrafts.project}
                      onChange={(event) => updateComposerDraft('project', event.target.value, event.target)}
                      className="max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                      placeholder="Post to this project session, ask a member, or start a new topic…"
                    />
                  </div>
                  <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-3 pt-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Button size="icon" variant="secondary" className="app-icon-button h-9 w-9 rounded-full border-0">
                        <Plus className="h-4 w-4" />
                      </Button>
                      <ComposerModeControl
                        scope="project"
                        selection={composerSelections.project}
                        openSelector={openComposerSelector}
                        onToggleSelector={toggleComposerSelector}
                        onSelectValue={selectComposerValue}
                      />
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <ComposerModelControls
                        scope="project"
                        selection={composerSelections.project}
                        openSelector={openComposerSelector}
                        onToggleSelector={toggleComposerSelector}
                        onSelectValue={selectComposerValue}
                      />
                      <Button className="app-composer-send h-10 w-10 rounded-full p-0">
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : activeNav === 'agents' ? (
            <AgentsPage
              agents={agents}
              activeAgentId={activeAgentId}
              activeAgent={activeAgent}
              isAgentOverlayOpen={isAgentOverlayOpen}
              onOpenAgent={(agentId) => {
                setActiveAgentId(agentId);
                setIsAgentOverlayOpen(true);
              }}
              onCloseOverlay={() => setIsAgentOverlayOpen(false)}
              getStatusBadgeClass={getStatusBadgeClass}
            />
          ) : activeNav === 'bridge' ? (
            <div className="h-full p-4">
              <div className="grid gap-4 text-white md:grid-cols-2">
                <Card className="rounded-3xl border-white/10 bg-white/5 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Your bridge membership</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-slate-300">
                    <div className="flex items-center justify-between">
                      <span>Joined bridges</span>
                      <span>3</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Discovery mode</span>
                      <span>Cross-bridge</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Reachable peers</span>
                      <span>24</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Recent failures</span>
                      <span>1 retry</span>
                    </div>
                  </CardContent>
                </Card>
                <Card className="rounded-3xl border-white/10 bg-white/5 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Quick actions</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    <Button variant="secondary" className="justify-start rounded-xl">
                      <KeyRound className="mr-2 h-4 w-4" /> Export identity
                    </Button>
                    <Button variant="secondary" className="justify-start rounded-xl">
                      <Link2 className="mr-2 h-4 w-4" /> Join another bridge
                    </Button>
                    <Button variant="secondary" className="justify-start rounded-xl">
                      <Activity className="mr-2 h-4 w-4" /> View route logs
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : activeNav === 'settings' ? (
            <div className="h-full">
              <div
                className="app-main-panel grid h-full w-full gap-0 overflow-hidden text-white"
                style={{ gridTemplateColumns: `${settingsRailWidth}px minmax(0, 1fr)` }}
              >
                <div className="app-session-panel p-2.5 shadow-[inset_-1px_0_0_var(--app-divider)]">
                  <div className="space-y-1">
                    {settingsSections.map((section) => {
                      const Icon = section.icon;
                      const active = activeSettingsSectionId === section.id;
                      return (
                        <button
                          key={section.id}
                          type="button"
                          onClick={() => setActiveSettingsSectionId(section.id)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition',
                            active ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                          )}
                        >
                          <div className={cn('grid h-8 w-8 place-items-center rounded-xl border', active ? 'border-white/15 bg-white/[0.06]' : 'border-transparent bg-transparent')}>
                            <Icon className={cn('h-3.5 w-3.5', active ? 'text-white' : 'text-slate-400')} />
                          </div>
                          <div className="text-[15px] font-medium leading-5">{section.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <ScrollArea className="app-main-panel h-full">
                  <div className="px-6 py-5">
                    <div className="mb-5">
                      <div className="text-[18px] font-semibold tracking-tight text-white">{activeSettingsSection.title}</div>
                      <div className="mt-2 max-w-2xl text-[13px] leading-5 text-slate-400">{activeSettingsSection.description}</div>
                    </div>
                    <div className="app-surface-muted overflow-hidden rounded-[26px] shadow-none">
                      {activeSettingsSection.items.map((item, index) => (
                        <div
                          key={item.label}
                          className={cn(
                            'grid items-center gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)]',
                            index > 0 ? 'border-t border-white/10' : '',
                          )}
                        >
                          <div>
                            <div className="text-[15px] font-medium text-white">{item.label}</div>
                            <div className="mt-1 text-[13px] leading-5 text-slate-400">{item.hint}</div>
                          </div>
                          <div className="flex justify-end">
                            <SettingsValueControl item={item} themeMode={themeMode} onToggleTheme={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </ScrollArea>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-1 flex-col">
              <div className="shrink-0 flex items-center justify-between border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  {showChatDetailRail && (
                    <button
                      type="button"
                      onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
                      className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] text-slate-100 transition"
                      aria-label={collapseChatSessions ? 'Open started sessions' : 'Close started sessions'}
                      title={collapseChatSessions ? 'Open started sessions' : 'Close started sessions'}
                    >
                      {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-white">
                    <h2 className="text-lg font-semibold">{activeConv.name}</h2>
                    <TypeBadge type={activeConv.type} />
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-slate-200">
                      <StatusPill>
                        <Shield className="h-3 w-3" /> {activeConv.trust}
                      </StatusPill>
                      {activeConv.bridges.map((bridge) => (
                        <StatusPill key={bridge}>
                          <Globe className="h-3 w-3" /> {bridge}
                        </StatusPill>
                      ))}
                      <StatusPill>
                        <ArrowRightLeft className="h-3 w-3" /> {activeConv.directness}
                      </StatusPill>
                    </div>
                  </div>
                </div>
                {showChatDetailRail && (
                  <button
                    type="button"
                    onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
                    className="app-icon-button app-utility-button grid h-7.5 w-7.5 place-items-center rounded-[12px] text-slate-100 transition"
                    aria-label={isDetailPanelCollapsed ? 'Open session detail panel' : 'Close session detail panel'}
                    title={isDetailPanelCollapsed ? 'Open session detail panel' : 'Close session detail panel'}
                  >
                    <span className="translate-y-[-1px] text-[16px] font-medium leading-none tracking-[0.08em]">...</span>
                  </button>
                )}
              </div>

              <ScrollArea className="min-h-0 flex-1 px-4 py-3">
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
                  {activeConv.messages.map((msg, idx) => (
                    <MessageBubble
                      key={`${msg.role}-${msg.time}-${idx}`}
                      msg={msg}
                      onOpenSource={(file) => {
                        setActiveSourcePreview(file);
                        setIsDetailPanelCollapsed(false);
                      }}
                    />
                  ))}
                </motion.div>
              </ScrollArea>

              <div className="shrink-0 border-t border-white/10 p-3">
                <div className="app-composer-shell rounded-[26px] p-3">
                  <div className="app-composer-input rounded-[18px] px-4 py-2.5 transition">
                    <textarea
                      rows={1}
                      value={composerDrafts.chat}
                      onChange={(event) => updateComposerDraft('chat', event.target.value, event.target)}
                      className="max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                      placeholder="Message a person, an agent, or delegate a task…"
                    />
                  </div>
                  <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-3 pt-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Button size="icon" variant="secondary" className="app-icon-button h-9 w-9 rounded-full border-0">
                        <Plus className="h-4 w-4" />
                      </Button>
                      <ComposerModeControl
                        scope="chat"
                        selection={composerSelections.chat}
                        openSelector={openComposerSelector}
                        onToggleSelector={toggleComposerSelector}
                        onSelectValue={selectComposerValue}
                      />
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <ComposerModelControls
                        scope="chat"
                        selection={composerSelections.chat}
                        openSelector={openComposerSelector}
                        onToggleSelector={toggleComposerSelector}
                        onSelectValue={selectComposerValue}
                      />
                      <Button className="app-composer-send h-10 w-10 rounded-full p-0">
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>

        {showRightDetailRail && !isDetailPanelCollapsed && (
        <aside className="app-main-panel min-w-0 text-white">
              <div className="flex h-full min-h-0 flex-col px-2.5 py-2.5">
              <div className="mb-2.5 shrink-0">
                <div className="app-inspector-tabs w-full">
                  {detailTabs.map((tab) => {
                    const active = activeDetailTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          setActiveDetailTab(tab.id);
                          setActiveSourcePreview(null);
                        }}
                        className={cn(
                          'app-inspector-tab',
                          active ? 'app-inspector-tab-active' : '',
                        )}
                        title={tab.label}
                        aria-label={tab.label}
                      >
                        <span className="truncate">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 pt-0.5">
                {activeSourcePreview ? (
                  <div className="space-y-3">
                    <div className="app-surface-muted flex items-center gap-2 overflow-hidden rounded-[22px] px-3 py-2.5">
                      <div className="app-input-shell inline-flex min-w-0 items-center gap-2 rounded-xl px-3 py-2">
                        <Braces className="h-4 w-4 shrink-0 text-slate-200" />
                        <span className="truncate text-[13px] font-medium text-white">{activeSourcePreview.path.split('/').pop()}</span>
                        <button
                          type="button"
                          onClick={() => setActiveSourcePreview(null)}
                          className="app-icon-button grid h-5 w-5 place-items-center rounded-md p-0 text-slate-400 transition hover:text-white"
                          aria-label="Close source preview"
                          title="Close source preview"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="min-w-0 truncate text-[12px] text-slate-500">{activeSourcePreview.path}</div>
                    </div>
                    <div className="app-code-panel overflow-hidden rounded-[24px] shadow-[var(--app-shadow-soft)]">
                      <div className="app-code-toolbar border-b border-white/10 px-4 py-2 text-[12px] text-slate-400">
                        Source preview
                      </div>
                      <div className="font-mono text-[12px] leading-7">
                        {(activeSourcePreview.sourceLines ?? []).map((line) => (
                          <div
                            key={`${activeSourcePreview.path}-${line.number}-${line.text}`}
                            className={cn(
                              'grid grid-cols-[56px_minmax(0,1fr)] px-4',
                              line.kind === 'add' ? 'bg-emerald-400/8' : '',
                            )}
                          >
                            <div className="select-none pr-3 text-right text-slate-500">{line.number}</div>
                            <code
                              className={cn(
                                'block min-w-0 overflow-hidden text-ellipsis whitespace-pre-wrap break-words',
                                line.kind === 'add' ? 'text-emerald-100' : 'text-slate-200',
                              )}
                            >
                              {line.text}
                            </code>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : activeNav === 'projects' ? (
                  <>
                    {activeDetailTab === 'info' && (
                      <div className="app-detail-sheet">
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Project info</div>
                          <div className="space-y-3 text-sm text-slate-300">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-medium text-white">{activeProject.name}</div>
                                <div className="mt-1 text-slate-400">{activeProject.scope}</div>
                              </div>
                              <Badge variant="outline" className={cn('rounded-full px-2.5 py-1 text-[10px]', getStatusBadgeClass(activeProject.status))}>
                                {activeProject.status}
                              </Badge>
                            </div>
                            <div className="grid gap-1.5">
                              <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                                <span>Bridge</span>
                                <span className="text-white">{activeProject.bridge}</span>
                              </div>
                              <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                                <span>Sessions</span>
                                <span className="text-white">{activeProject.sessions.length}</span>
                              </div>
                              <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                                <span>Artifacts</span>
                                <span className="text-white">{activeProject.artifacts}</span>
                              </div>
                            </div>
                          </div>
                        </section>
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Project actions</div>
                          <div className="grid gap-2">
                            <Button variant="secondary" className="app-control-chip justify-start rounded-[14px] border-0 text-[12px]">
                              <Users className="mr-2 h-3.5 w-3.5" />
                              Invite people
                            </Button>
                            <Button variant="secondary" className="app-control-chip justify-start rounded-[14px] border-0 text-[12px]">
                              <Bot className="mr-2 h-3.5 w-3.5" />
                              Invite agent
                            </Button>
                            <Button
                              variant="outline"
                              className="justify-start rounded-[14px] border-white/15 text-[12px] text-slate-200"
                              onClick={() => setActiveDetailTab('tasks')}
                            >
                              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                              Review invites
                            </Button>
                          </div>
                        </section>
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Members</div>
                          <div className="space-y-1.5">
                            {[...activeProject.people, ...activeProject.agents].map((member) => (
                              <div key={member} className="app-detail-row flex items-center justify-between px-3 py-2.5 text-sm">
                                <span>{member}</span>
                                <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                                  Active
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </section>
                      </div>
                    )}

                    {activeDetailTab === 'context' && (
                      <div className="app-detail-sheet">
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Project context</div>
                          <div className="space-y-3 text-sm text-slate-300">
                            <div className="app-detail-note px-3 py-3">
                              <div className="mb-1 font-medium text-white">Project summary</div>
                              <div>{activeProject.summary}</div>
                            </div>
                            <div className="app-detail-note px-3 py-3">
                              <div className="mb-1 font-medium text-white">Active session</div>
                              <div>{activeProjectSession.summary}</div>
                            </div>
                          </div>
                        </section>
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Latest activity</div>
                          <div className="space-y-1.5 text-sm text-slate-300">
                            <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                              <span>Last active</span>
                              <span className="text-white">{activeProjectSession.lastActive}</span>
                            </div>
                            <div className="app-detail-row flex items-center justify-between gap-3 px-3 py-2.5">
                              <span>Latest message</span>
                              <span className="max-w-[150px] truncate text-right text-white">{activeProjectLastMessage?.sender}</span>
                            </div>
                            <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                              <span>Session status</span>
                              <Badge variant="secondary" className={cn('rounded-full px-2.5 py-1', getStatusBadgeClass(activeProjectSession.status))}>
                                {activeProjectSession.status}
                              </Badge>
                            </div>
                          </div>
                        </section>
                      </div>
                    )}

                    {activeDetailTab === 'artifacts' && (
                      <div className="app-detail-sheet">
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Artifacts</div>
                          <div className="space-y-3">
                            <div className="app-detail-note p-3">
                              <div className="mb-1 font-medium text-white">Project artifact count</div>
                              <div className="text-sm text-slate-300">{activeProject.artifacts} shared artifacts tracked in this workspace.</div>
                            </div>
                            <div className="app-detail-note p-3">
                              <div className="mb-1 font-medium text-white">Session materials</div>
                              <div className="text-sm text-slate-300">{activeProjectSession.artifacts} items currently attached to this session.</div>
                            </div>
                          </div>
                        </section>
                      </div>
                    )}

                    {activeDetailTab === 'tasks' && (
                      <div className="app-detail-sheet">
                        <section className="app-detail-section">
                          <div className="app-detail-kicker">Tasks</div>
                          <div className="space-y-3">
                            <div className="app-detail-note p-3">
                              <div className="mb-1 flex items-center justify-between">
                                <span className="font-medium text-white">Project tasks</span>
                                <Badge className="app-badge-neutral px-2.5 py-1">{activeProject.tasks}</Badge>
                              </div>
                              <div className="text-sm text-slate-300">Open tasks tracked across all project sessions.</div>
                            </div>
                            <div className="app-detail-note p-3">
                              <div className="mb-1 flex items-center justify-between">
                                <span className="font-medium text-white">Pending invites</span>
                                <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">{activeProject.pendingInvites.length}</Badge>
                              </div>
                              <div className="text-sm text-slate-300">Membership approvals still waiting at the project level.</div>
                            </div>
                          </div>
                        </section>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                {activeDetailTab === 'info' && (
                  <div className="app-detail-sheet">
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Session info</div>
                      <div className="space-y-3 text-sm text-slate-300">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-white">{activeConv.name}</div>
                            <div className="mt-1 text-slate-400">{activeConv.subtitle}</div>
                          </div>
                          <TypeBadge type={activeConv.type} />
                        </div>
                          <div className="grid gap-1.5">
                          <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                            <span>Last active</span>
                            <span className="text-white">{activeLastMessage?.time}</span>
                          </div>
                          <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                            <span>Trust</span>
                            <span className="text-white">{activeConv.trust}</span>
                          </div>
                          <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                            <span>Mode</span>
                            <span className="text-white">{activeConv.directness}</span>
                          </div>
                        </div>
                      </div>
                    </section>
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Participants</div>
                      <div className="space-y-1.5">
                        {activeConv.participants.map((participant) => (
                          <div key={participant} className="app-detail-row flex items-center justify-between px-3 py-2.5 text-sm">
                            <span>{participant}</span>
                            <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                              Active
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                )}

                {activeDetailTab === 'context' && (
                  <div className="app-detail-sheet">
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Session context</div>
                      <div className="space-y-3 text-sm text-slate-300">
                        <div className="app-detail-note px-3 py-3">
                          <div className="mb-1 font-medium text-white">Current focus</div>
                          <div>{activeConv.subtitle}</div>
                        </div>
                        <div className="app-detail-note px-3 py-3">
                          <div className="mb-1 font-medium text-white">Latest update</div>
                          <div>{activeLastMessage?.text}</div>
                        </div>
                      </div>
                    </section>
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Delivery context</div>
                      <div className="space-y-2 text-sm text-slate-300">
                        <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                          <span>Bridges</span>
                          <span className="text-white">{activeConv.bridges.join(' • ')}</span>
                        </div>
                        <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                          <span>Source</span>
                          <span className="text-white">cc_node_01</span>
                        </div>
                        <div className="app-detail-row flex items-center justify-between px-3 py-2.5">
                          <span>Transport</span>
                          <span className="text-white">Encrypted</span>
                        </div>
                      </div>
                    </section>
                  </div>
                )}

                {activeDetailTab === 'artifacts' && (
                  <div className="app-detail-sheet">
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Artifacts</div>
                      <div className="space-y-3">
                        <div className="app-detail-note p-3">
                          <div className="mb-1 font-medium text-white">Concise literature summary</div>
                          <div className="text-sm text-slate-300">One-page summary received from Alice’s Research Agent.</div>
                        </div>
                        <div className="app-detail-note p-3">
                          <div className="mb-1 font-medium text-white">Thread trace</div>
                          <div className="text-sm text-slate-300">Delegation history, route, and approval log.</div>
                        </div>
                      </div>
                    </section>
                  </div>
                )}

                {activeDetailTab === 'tasks' && (
                  <div className="app-detail-sheet">
                    <section className="app-detail-section">
                      <div className="app-detail-kicker">Tasks</div>
                      <div className="space-y-3">
                        <div className="app-detail-note p-3">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-medium text-white">Research Agent relay</span>
                            <Badge className="app-badge-neutral px-2.5 py-1">Running</Badge>
                          </div>
                          <div className="text-sm text-slate-300">Waiting for external follow-up notes.</div>
                        </div>
                        <div className="app-detail-note p-3">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-medium text-white">Code Agent outbound share</span>
                            <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">Needs approval</Badge>
                          </div>
                          <div className="text-sm text-slate-300">Agent wants to send a patch summary to Bob.</div>
                        </div>
                      </div>
                    </section>
                  </div>
                )}
                  </>
                )}
              </div>
            </div>
        </aside>
          )}
          {showRightDetailRail && !isDetailPanelCollapsed && (
            <div
              onMouseDown={startPanelResize('detail')}
              className="absolute bottom-0 top-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `calc(100% - ${detailRailWidth}px)` }}
              aria-hidden="true"
            >
              <div className="mx-auto h-full w-px bg-white/8 transition hover:bg-white/20" />
            </div>
          )}
          </div>
        </section>
        </div>
        <div onMouseDown={startWindowResize('left')} className="absolute inset-y-6 left-0 z-30 w-2 cursor-ew-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('right')} className="absolute inset-y-6 right-0 z-30 w-2 cursor-ew-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('top')} className="absolute left-6 right-6 top-0 z-30 h-2 cursor-ns-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('bottom')} className="absolute bottom-0 left-6 right-6 z-30 h-2 cursor-ns-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('top-left')} className="absolute left-0 top-0 z-40 h-5 w-5 cursor-nwse-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('top-right')} className="absolute right-0 top-0 z-40 h-5 w-5 cursor-nesw-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('bottom-left')} className="absolute bottom-0 left-0 z-40 h-5 w-5 cursor-nesw-resize" aria-hidden="true" />
        <div onMouseDown={startWindowResize('bottom-right')} className="absolute bottom-0 right-0 z-40 h-5 w-5 cursor-nwse-resize" aria-hidden="true" />
      </div>
    </div>
  );
}
