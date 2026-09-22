import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Moon, PanelLeft, Plus, Sun } from 'lucide-react';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { buildParticipantSpaces, filterParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { ChatProjectsContext, type ChatProject, projectForChat } from '../../src/features/projects/chatProjects';
import type { Conversation } from '../../src/kordi-app/types';
import { ChatsPage } from '../../src/pages/ChatsPage';
import type { ChatsPageProps } from '../../src/pages/chatsPage.types';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from '../../src/pages/WorkspaceSidebar';
import { baseSidebarProps } from '../helpers/workspaceSidebarParticipantSpacesFixtures';
import { ProjectImportPreview, type ImportedProject } from './chatProjectImport';
import '../../src/index.css';
import './chatProjectWorkspace.css';

type PreviewChatsPageProps = ChatsPageProps['layout'] & ChatsPageProps['session'] & ChatsPageProps['transcript'] & ChatsPageProps['composer'] & ChatsPageProps['runtime'] & ChatsPageProps['auth'];
const initialTitles = ['Fix transcript scroll jitter', 'Redesign message forwarding', 'Compare Kordi and Codex', 'Fix agent session drafts', 'Review the homepage', 'Update typography', 'Explore an idea'];
function makeConversation(id: string, name: string, index = 0): Conversation {
  return { id, canonicalSessionId: id, name, type: 'owned-agent', subtitle: '', unread: 0,
    desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: true, collaborationSources: ['Local'], trust: 'Owned', directness: 'Agent chat',
    participants: ['Me', 'Kordi'], canonicalParticipants: [
      { id: 'human:preview', name: 'Me', kind: 'human', role: 'self', source: 'local' },
      { id: 'agent:preview', name: 'Kordi', kind: 'agent', role: 'owned-agent', source: 'local' },
    ], updatedAtLabel: `${12 - index}:20`, messages: id === 'chat-2' ? [
      { id: 'request', role: 'user', sender: 'Me', isOwnMessage: true, text: 'Keep project selection in the chat. I want to organize agent sessions by project and open projects from GitHub or a local folder.', time: '12:20' },
      { id: 'reply', role: 'owned-agent', sender: 'Kordi', text: 'Here is the proposed flow:\n\n- Choose a project below the message box.\n- Keep related sessions together under its folder in Agent Chat.\n- Right-click a session to move it to another project.\n- Add a local folder or choose a GitHub repository from New project.\n\nYou can try the selection and organization in this preview.', time: '12:21' },
    ] : [{ id: `${id}-intro`, role: 'user', sender: 'Me', isOwnMessage: true, text: name, time: '12:20' }],
  };
}
const initialProjects: ChatProject[] = [
  { id: 'kordi', name: 'kordi', root: '/preview/kordi', sessions: [0, 1, 2, 3].map((n) => ({ id: `chat-${n}` })) },
  { id: 'website', name: 'website', root: '/preview/website', sessions: [4, 5].map((n) => ({ id: `chat-${n}` })) },
];

function ProjectWorkspacePreview() {
  const [appearance, setAppearance] = useState(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
  const [projects, setProjects] = useState(initialProjects);
  const [conversations, setConversations] = useState(() => initialTitles.map((title, index) => makeConversation(`chat-${index}`, title, index)));
  const [activeId, setActiveId] = useState('chat-2');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [importSessionId, setImportSessionId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [notice, setNotice] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((conversation) => conversation.id === activeId)!;
  const selected = projectForChat(projects, activeId);
  const participantSpaces = buildParticipantSpaces(conversations);
  const setDraft = (text: string) => setDrafts((current) => ({ ...current, [activeId]: text }));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { document.body.classList.toggle('theme-light', appearance === 'light'); }, [appearance]);
  const assign = async (sessionId: string, root: string) => {
    if (!sessionId) { newSession(root); return; }
    setProjects((current) => current.map((project) => ({ ...project, sessions: [
      ...project.sessions.filter((session) => session.id !== sessionId),
      ...(project.root === root ? [{ id: sessionId }] : []),
    ] })));
  };
  const newSession = (root = selected?.root) => {
    const id = `preview-${crypto.randomUUID()}`;
    setConversations((current) => [{ ...makeConversation(id, 'New session'), messages: [] }, ...current]);
    if (root) void assign(id, root);
    setActiveId(id);
    return id;
  };
  const importProject = (project: ImportedProject) => {
    const sessionId = importSessionId ?? activeId;
    const exists = projects.find((candidate) => candidate.root === project.root);
    setProjects((current) => [
      ...current.map((candidate) => ({ ...candidate, sessions: [
        ...candidate.sessions.filter((session) => session.id !== sessionId),
        ...(candidate.root === project.root ? [{ id: sessionId }] : []),
      ] })),
      ...(exists ? [] : [{ ...project, id: `project-${project.name}`, sessions: [{ id: sessionId }] }]),
    ]);
    setImportSessionId(null);
    setNotice(`${project.name} added to this preview${project.source === 'github' ? ' from a demo GitHub selection' : ''}.`);
  };
  const send = () => {
    const text = drafts[activeId]?.trim();
    if (!text) return;
    setConversations((current) => current.map((conversation) => conversation.id !== activeId ? conversation : {
      ...conversation, name: conversation.name === 'New session' ? text : conversation.name,
      messages: [...conversation.messages, { id: `msg-${Date.now()}`, role: 'user', sender: 'Me', isOwnMessage: true, text, time: 'Now' }],
    }));
    setDraft('');
    setNotice('Message added to the preview. No agent task was started.');
  };
  const pageProps = {
    isNativeShell: true,
    showChatDetailRail: false,
    collapseChatSessions: !sidebarVisible,
    setIsSessionPanelCollapsed: (collapsed: boolean) => setSidebarVisible(!collapsed),
    showRightDetailRail: false,
    isDetailPanelCollapsed: true,
    setIsDetailPanelCollapsed: () => undefined,
    activeDetailTab: 'messages',
    setActiveDetailTab: () => undefined,
    activeArtifactId: null,
    setActiveArtifactId: () => undefined,
    activeConv: active,
    chatConversations: conversations,
    companionConversations: [],
    participantSpaces,
    activeConversationUsesCollaboration: false,
    activeCollaborationModelHost: null,
    desktopChatState: null,
    onUpdateCollaborationAgentModelRouting: async () => undefined,
    isEditingDesktopSessionTitle: false,
    setIsEditingDesktopSessionTitle: () => undefined,
    desktopSessionRenameDraft: '',
    setDesktopSessionRenameDraft: () => undefined,
    onRenameDesktopSession: async () => undefined,
    onRenameChatSession: async () => undefined,
    chatTranscriptScrollRef: transcriptRef,
    onTranscriptScroll: () => undefined,
    onOpenSource: () => undefined,
    onOpenArtifact: () => undefined,
    desktopLiveTurn: null,
    queuedDesktopMessages: [],
    queuedDesktopMessagesBySession: {},
    onEditQueuedMessage: () => undefined,
    onCancelQueuedMessage: () => undefined,
    filteredChatSlashCommands: [],
    chatMentionTargetsForText: () => [],
    chatSlashMenuIndex: 0,
    setChatSlashMenuIndex: () => undefined,
    acceptChatSlashCommand: () => undefined,
    chatAttachmentInputRef: { current: null },
    chatComposerAttachments: [],
    saveDesktopAttachments: async () => [],
    saveDesktopAttachmentPaths: async () => [],
    removeChatComposerAttachment: () => undefined,
    updateChatComposerAttachment: () => undefined,
    chatComposerText: drafts[activeId] ?? '',
    updateChatComposerDraft: (value: string) => setDraft(value),
    setChatComposerText: setDraft,
    setChatComposerTextForSession: (_sessionId: string, value: string) => setDraft(value),
    composerControlsRef: { current: null },
    activeRuntimeContextStatus: null,
    activeRuntimeCacheText: null,
    composerSelection: { mode: 'Send as Me', model: 'GPT-5.6', thinking: 'default' },
    openComposerSelector: null,
    toggleComposerSelector: () => undefined,
    selectComposerValue: () => undefined,
    composerAuthLabel: 'Preview account',
    composerAuthOptions: [],
    selectComposerAuthChoice: () => undefined,
    selectComposerProviderChoice: () => undefined,
    composerProviderOptions: [],
    chatModelOptions: [],
    isDesktopChatSending: false,
    onStopDesktopChatTurn: () => undefined,
    onStopCollaborationAgentRequest: () => undefined,
    onRequestCollaborationContact: () => undefined,
    onForkChatMessage: async () => undefined,
    onPrefetchChatSession: async () => undefined,
    onSelectSession: setActiveId,
    onSendChatMessage: send,
    onCreateAgentSession: () => newSession(),
    hasAnyAuth: true,
    onOpenAuthSettings: () => undefined,
    onOpenAccountAuthentication: () => undefined,
  } as unknown as PreviewChatsPageProps;
  const sidebar = baseSidebarProps({ isNativeShell: true, chatConversations: conversations, participantSpaces,
    filteredConversations: conversations, contactParticipantSpaces: [], agentParticipantSpaces: filterParticipantSpaces(participantSpaces, '', 'agent'),
    initialChatChannel: 'agent', activeConvId: activeId, chatSearch: search, setChatSearch: setSearch,
    onSelectChatSession: setActiveId, onPrefetchChatSession: async () => undefined,
    onStartChatWithAgent: () => newSession(), onCreateChatSession: () => newSession(),
    onRenameChatSession: async (id: string, name: string) => setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, name } : conversation)),
    onDeleteChatSession: async (id: string) => { setConversations((current) => current.filter((conversation) => conversation.id !== id)); if (activeId === id) setActiveId(conversations.find((conversation) => conversation.id !== id)!.id); },
    isCollaborationSyncing: false, isCollaborationSyncUnavailable: false,
    displayedAgents: [{ id: 'agent:preview', name: 'Kordi', role: 'Your agent', status: 'Ready', messaging: 'Available', tasks: 0, collaborationConfig: 'Local', lastActivities: [] }],
  });
  return <div className={`project-workspace-review theme-${appearance}`}>
    <div className="project-review-toolbar">
      <span><strong>Project workspace</strong><span className="project-review-toolbar-note">Interactive design preview · Demo data</span></span>
      <div>
        <button aria-label="Toggle sessions" onClick={() => setSidebarVisible((current) => !current)}><PanelLeft size={15} /></button>
        <button onClick={() => newSession()}><Plus size={15} /><span>New session</span></button>
        <button aria-label="Toggle appearance" onClick={() => setAppearance((current) => current === 'light' ? 'dark' : 'light')}>{appearance === 'light' ? <Moon size={15} /> : <Sun size={15} />}</button>
      </div>
    </div>
    <ChatProjectsContext value={{ enabled: true, projects, assign, openImporter: (sessionId) => setImportSessionId(sessionId || activeId), create: async (_sessionId, name, folder) => importProject({ name, root: folder || `/preview/${name}`, source: 'local' }) }}>
      <AppShellFrame rootThemeClass={`theme-${appearance}`} isNativeShell={false} isLayoutResizing={false}
        windowSize={{ width: viewport.width, height: viewport.height - 42 }} leftWorkspaceWidth={338}
        isSingleWorkspacePage={false} showSessionRail={sidebarVisible} collapseChatSessions={!sidebarVisible}
        showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={300}
        onSessionResizeMouseDown={() => undefined} onDetailResizeMouseDown={() => undefined}
        sidebar={<WorkspaceSidebar {...sidebar as unknown as WorkspaceSidebarProps} layout={{ ...sidebar.layout, collapseChatSessions: !sidebarVisible } as WorkspaceSidebarProps['layout']} />}
        mainContent={<ChatsPage layout={pageProps} session={pageProps} transcript={pageProps} composer={pageProps} runtime={pageProps} auth={pageProps} />}
      />
    </ChatProjectsContext>
    {notice ? <div role="status" className="project-review-notice" onClick={() => setNotice('')}>{notice}</div> : null}
    {importSessionId ? <ProjectImportPreview onClose={() => setImportSessionId(null)} onImport={importProject} /> : null}
  </div>;
}
createRoot(document.getElementById('root')!).render(<ProjectWorkspacePreview />);
