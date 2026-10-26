import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { useWorkspaceController } from '../../src/app/useWorkspaceController';
import { useKordiLocalUiState } from '../../src/app/useKordiLocalUiState';
import { chatNavigationIndex } from '../../src/features/chat/chatNavigation';
import { buildParticipantSpaces, filterParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { setPersonalAgentEntries } from '../../src/features/personalAgent/personalAgentStore';
import { ChatProjectsContext } from '../../src/features/projects/chatProjects';
import { LEFT_RAIL_WIDTH } from '../../src/kordi-app/layout';
import { ChatsPage } from '../../src/pages/ChatsPage';
import type { ChatsPageProps } from '../../src/pages/chatsPage.types';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from '../../src/pages/WorkspaceSidebar';
import { baseSidebarProps } from '../helpers/workspaceSidebarParticipantSpacesFixtures';
import { KORDI_SESSION, previewConversations, previewPersonalAgents, userMessage } from './personalAgentPreviewData';
import '../../src/index.css';
import './chatProjectWorkspace.css';

// Login-free preview of the Personal agent section (#2091): the real sidebar
// and chat with synthetic agents. `?theme=dark`, `?state=off` (Proactive off:
// the agent answers when asked), `?session=<id>` to open another chat.

type PreviewChatsPageProps = ChatsPageProps['layout'] & ChatsPageProps['session'] & ChatsPageProps['transcript'] & ChatsPageProps['composer'] & ChatsPageProps['runtime'] & ChatsPageProps['auth'];

setPersonalAgentEntries(previewPersonalAgents);
const params = new URLSearchParams(location.search);
const initialSessionId = params.get('session') || KORDI_SESSION;

function PersonalAgentPreview() {
  const appearance = params.get('theme') === 'dark' ? 'dark' : 'light';
  const { activeNav, setActiveNav, activeConvId: activeId, setActiveConvId: setActiveId, updateChatNavigationIndex } = useWorkspaceController({ initialProjects: [], isNativeShell: true });
  const { chatsUi: { chatSearch: search, setChatSearch: setSearch } } = useKordiLocalUiState(activeNav);
  const [conversations, setConversations] = useState(() => previewConversations(params.get('state') === 'off'));
  const destinations = useMemo(() => chatNavigationIndex(conversations), [conversations]);
  useEffect(() => updateChatNavigationIndex(destinations), [destinations, updateChatNavigationIndex]);
  useEffect(() => { setActiveNav('agent-chats'); setActiveId(initialSessionId); }, [setActiveId, setActiveNav]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mutedSessionIds, setMutedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [notice, setNotice] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0]!;
  const participantSpaces = buildParticipantSpaces(conversations);
  const setDraft = (text: string) => setDrafts((current) => ({ ...current, [activeId]: text }));
  const toggle = (setter: typeof setMutedSessionIds) => (id: string, value: boolean) => setter((current) => {
    const next = new Set(current);
    if (value) next.add(id); else next.delete(id);
    return next;
  });
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { document.body.classList.toggle('theme-light', appearance === 'light'); }, [appearance]);
  const select = (id: string) => {
    setActiveId(id);
    setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, unread: 0 } : conversation));
    toggle(setUnreadSessionIds)(id, false);
  };
  const send = () => {
    const text = drafts[activeId]?.trim();
    if (!text) return;
    setConversations((current) => current.map((conversation) => conversation.id !== activeId ? conversation : {
      ...conversation, messages: [...conversation.messages, userMessage(`msg-${Date.now()}`, text, 'Now', Date.now())],
    }));
    setDraft('');
    setNotice('Message added to the preview. No agent task was started.');
  };
  const pageProps = {
    isNativeShell: true, showChatDetailRail: false, collapseChatSessions: !sidebarVisible,
    setIsSessionPanelCollapsed: (collapsed: boolean) => setSidebarVisible(!collapsed),
    showRightDetailRail: false, isDetailPanelCollapsed: true, setIsDetailPanelCollapsed: () => undefined,
    activeDetailTab: 'messages', setActiveDetailTab: () => undefined, activeArtifactId: null, setActiveArtifactId: () => undefined,
    activeConv: active, chatConversations: conversations, companionConversations: conversations, participantSpaces,
    activeConversationUsesCollaboration: false, activeCollaborationModelHost: null, desktopChatState: null,
    onUpdateCollaborationAgentModelRouting: async () => undefined,
    isEditingDesktopSessionTitle: false, setIsEditingDesktopSessionTitle: () => undefined,
    desktopSessionRenameDraft: '', setDesktopSessionRenameDraft: () => undefined,
    onRenameDesktopSession: async () => undefined, onRenameChatSession: async () => undefined,
    chatTranscriptScrollRef: transcriptRef, onTranscriptScroll: () => undefined, onOpenSource: () => undefined, onOpenArtifact: () => undefined,
    desktopLiveTurn: null, queuedDesktopMessages: [], queuedDesktopMessagesBySession: {},
    onEditQueuedMessage: () => undefined, onCancelQueuedMessage: () => undefined,
    filteredChatSlashCommands: [], chatMentionTargetsForText: () => [], chatSlashMenuIndex: 0, setChatSlashMenuIndex: () => undefined, acceptChatSlashCommand: () => undefined,
    chatAttachmentInputRef: { current: null }, chatComposerAttachments: [], saveDesktopAttachments: async () => [], saveDesktopAttachmentPaths: async () => [],
    removeChatComposerAttachment: () => undefined, updateChatComposerAttachment: () => undefined,
    chatComposerText: drafts[activeId] ?? '', updateChatComposerDraft: (value: string) => setDraft(value), setChatComposerText: setDraft,
    setChatComposerTextForSession: (sessionId: string, value: string) => setDrafts((current) => ({ ...current, [sessionId]: value })),
    composerControlsRef: { current: null }, activeRuntimeContextStatus: null, activeRuntimeCacheText: null,
    composerSelection: { mode: 'Send as Me', model: 'GPT-5.6', thinking: 'default' }, openComposerSelector: null,
    toggleComposerSelector: () => undefined, selectComposerValue: () => undefined, composerAuthLabel: 'Preview account', composerAuthOptions: [],
    selectComposerAuthChoice: () => undefined, selectComposerProviderChoice: () => undefined, composerProviderOptions: [], chatModelOptions: [],
    isDesktopChatSending: false, onStopDesktopChatTurn: () => undefined, onStopCollaborationAgentRequest: () => undefined,
    onRequestCollaborationContact: () => undefined, onForkChatMessage: async () => undefined, onPrefetchChatSession: async () => undefined,
    onSelectSession: select, onSendChatMessage: send, onCreateAgentSession: () => undefined,
    hasAnyAuth: true, onOpenAuthSettings: () => undefined, onOpenAccountAuthentication: () => undefined,
  } as unknown as PreviewChatsPageProps;
  const sidebar = baseSidebarProps({ isNativeShell: true, chatConversations: conversations, participantSpaces,
    filteredConversations: conversations, contactParticipantSpaces: filterParticipantSpaces(participantSpaces, search, 'contact'), agentParticipantSpaces: filterParticipantSpaces(participantSpaces, search, 'agent'),
    activeNav, setActiveNav, initialChatChannel: 'agent', activeConvId: activeId, chatSearch: search, setChatSearch: setSearch,
    mutedSessionIds, unreadSessionIds,
    onSetChatSessionMuted: toggle(setMutedSessionIds), onSetChatSessionUnread: toggle(setUnreadSessionIds),
    onSelectChatSession: select, onPrefetchChatSession: async () => undefined,
    onOpenAgentSettings: (agentId: string) => setNotice(`Agent settings would open the Blueprint of ${previewPersonalAgents.find((entry) => entry.localAgentId === agentId)?.name ?? 'this agent'}.`),
    isCollaborationSyncing: false, isCollaborationSyncUnavailable: false,
  });
  return <div className={`project-workspace-review theme-${appearance}`}>
    <ChatProjectsContext value={{ enabled: false, projects: [], assign: async () => undefined, create: async () => undefined }}>
      <AppShellFrame rootThemeClass={`theme-${appearance}`} isNativeShell isLayoutResizing={false}
        windowTitle={active.name} onToggleSessionPanel={() => setSidebarVisible((current) => !current)}
        windowSize={{ width: viewport.width, height: viewport.height }} leftWorkspaceWidth={LEFT_RAIL_WIDTH + (sidebarVisible ? sidebar.layout.sessionRailWidth : 0)}
        isSingleWorkspacePage={false} showSessionRail={sidebarVisible} collapseChatSessions={!sidebarVisible}
        showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={300}
        onSessionResizeMouseDown={() => undefined} onDetailResizeMouseDown={() => undefined}
        sidebar={<WorkspaceSidebar {...sidebar as unknown as WorkspaceSidebarProps} layout={{ ...sidebar.layout, collapseChatSessions: !sidebarVisible } as WorkspaceSidebarProps['layout']} />}
        mainContent={<ChatsPage layout={pageProps} session={pageProps} transcript={pageProps} composer={pageProps} runtime={pageProps} auth={pageProps} />}
      />
    </ChatProjectsContext>
    {notice ? <div role="status" className="project-review-notice" onClick={() => setNotice('')}>{notice}</div> : null}
  </div>;
}
createRoot(document.getElementById('root')!).render(<PersonalAgentPreview />);
