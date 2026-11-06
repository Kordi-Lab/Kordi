import './previewChatTheme';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { LEFT_RAIL_WIDTH } from '../../src/kordi-app/layout';
import { buildParticipantSpaces, filterParticipantSpaces } from '../../src/features/chat/participantSpaces';
import type { Conversation } from '../../src/kordi-app/types';
import { ChatsPage } from '../../src/pages/ChatsPage';
import type { ChatsPageProps } from '../../src/pages/chatsPage.types';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from '../../src/pages/WorkspaceSidebar';
import { baseSidebarProps } from '../helpers/workspaceSidebarParticipantSpacesFixtures';
import '../../src/index.css';
import './chatProjectWorkspace.css';

// Login-free preview: the real chat page with no provider connected, so the
// composer carries the provider tray. ?theme=dark switches appearance and
// ?provider=1 shows the connected state without the tray.
type PreviewChatsPageProps = ChatsPageProps['layout'] & ChatsPageProps['session'] & ChatsPageProps['transcript'] & ChatsPageProps['composer'] & ChatsPageProps['runtime'] & ChatsPageProps['auth'];

const params = new URLSearchParams(location.search);
const appearance = params.get('theme') === 'dark' ? 'dark' : 'light';
const hasAnyAuth = params.get('provider') === '1';

function makeConversation(id: string, name: string, index = 0): Conversation {
  return { id, canonicalSessionId: id, name, type: 'owned-agent', subtitle: '', unread: 0,
    desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: true, collaborationSources: ['Local'], trust: 'Owned', directness: 'Agent chat',
    participants: ['Me', 'Kordi'], canonicalParticipants: [
      { id: 'human:preview', name: 'Me', kind: 'human', role: 'self', source: 'local' },
      { id: 'agent:preview', name: 'Kordi', kind: 'agent', role: 'owned-agent', source: 'local' },
    ], updatedAtLabel: `${12 - index}:20`, messages: [],
  };
}
const titles = ['Plan the launch checklist', 'Summarize the design review', 'Draft the weekly update', 'Explore an idea'];

function ProviderConnectTrayPreview() {
  const [conversations] = useState(() => titles.map((title, index) => {
    const conversation = makeConversation(`chat-${index}`, title, index);
    if (index === 0) conversation.messages = [
      { id: 'request', role: 'user', sender: 'Me', isOwnMessage: true, text: 'Help me plan the launch checklist for next week.', time: '12:20' },
    ];
    return conversation;
  }));
  const [activeId, setActiveId] = useState('chat-0');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [opened, setOpened] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((conversation) => conversation.id === activeId)!;
  const participantSpaces = buildParticipantSpaces(conversations);
  const openAuthentication = () => setOpened((count) => count + 1);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { document.body.classList.toggle('theme-light', appearance === 'light'); }, []);
  const pageProps = {
    isNativeShell: true, showChatDetailRail: false, collapseChatSessions: !sidebarVisible,
    setIsSessionPanelCollapsed: (collapsed: boolean) => setSidebarVisible(!collapsed),
    showRightDetailRail: false, isDetailPanelCollapsed: true, setIsDetailPanelCollapsed: () => undefined,
    activeDetailTab: 'info', setActiveDetailTab: () => undefined, activeArtifactId: null, setActiveArtifactId: () => undefined,
    activeConv: active, chatConversations: conversations, companionConversations: conversations, participantSpaces,
    activeConversationUsesCollaboration: false, activeCollaborationModelHost: null, desktopChatState: null,
    onUpdateCollaborationAgentModelRouting: async () => undefined,
    isEditingDesktopSessionTitle: false, setIsEditingDesktopSessionTitle: () => undefined,
    desktopSessionRenameDraft: '', setDesktopSessionRenameDraft: () => undefined,
    onRenameDesktopSession: async () => undefined, onRenameChatSession: async () => undefined,
    chatTranscriptScrollRef: transcriptRef, onTranscriptScroll: () => undefined,
    onOpenSource: () => undefined, onOpenArtifact: () => undefined,
    desktopLiveTurn: null, queuedDesktopMessages: [], queuedDesktopMessagesBySession: {},
    onEditQueuedMessage: () => undefined, onCancelQueuedMessage: () => undefined,
    filteredChatSlashCommands: [], chatMentionTargetsForText: () => [], chatSlashMenuIndex: 0,
    setChatSlashMenuIndex: () => undefined, acceptChatSlashCommand: () => undefined,
    chatAttachmentInputRef: { current: null }, chatComposerAttachments: [],
    saveDesktopAttachments: async () => [], saveDesktopAttachmentPaths: async () => [],
    removeChatComposerAttachment: () => undefined, updateChatComposerAttachment: () => undefined,
    chatComposerText: draft, updateChatComposerDraft: setDraft, setChatComposerText: setDraft,
    setChatComposerTextForSession: (_sessionId: string, value: string) => setDraft(value),
    composerControlsRef: { current: null }, activeRuntimeContextStatus: null, activeRuntimeCacheText: null,
    composerSelection: { mode: 'Send as Me', model: '', thinking: 'default' },
    openComposerSelector: null, toggleComposerSelector: () => undefined, selectComposerValue: () => undefined,
    composerAuthLabel: '', composerAuthOptions: [], selectComposerAuthChoice: () => undefined,
    selectComposerProviderChoice: () => undefined, composerProviderOptions: [], chatModelOptions: [],
    isDesktopChatSending: false, onStopDesktopChatTurn: () => undefined, onStopCollaborationAgentRequest: () => undefined,
    onRequestCollaborationContact: () => undefined, onForkChatMessage: async () => undefined,
    onPrefetchChatSession: async () => undefined, onSelectSession: setActiveId,
    onSendChatMessage: () => undefined, onCreateAgentSession: () => undefined,
    hasAnyAuth,
    onOpenAuthSettings: openAuthentication, onOpenAccountAuthentication: openAuthentication,
  } as unknown as PreviewChatsPageProps;
  const sidebar = baseSidebarProps({ isNativeShell: true, chatConversations: conversations, participantSpaces,
    filteredConversations: conversations, contactParticipantSpaces: [], agentParticipantSpaces: filterParticipantSpaces(participantSpaces, search, 'agent'),
    initialChatChannel: 'agent', activeConvId: activeId, chatSearch: search, setChatSearch: setSearch,
    onSelectChatSession: setActiveId, onPrefetchChatSession: async () => undefined,
    isCollaborationSyncing: false, isCollaborationSyncUnavailable: false,
    displayedAgents: [{ id: 'agent:preview', name: 'Kordi', role: 'Your agent', status: 'Ready', messaging: 'Available', tasks: 0, collaborationConfig: 'Local', lastActivities: [] }],
  });
  return <div className={`project-workspace-review theme-${appearance}`} data-opened-authentication={opened}>
    <AppShellFrame rootThemeClass={`theme-${appearance}`} isNativeShell isLayoutResizing={false}
      windowTitle={active.name} onToggleSessionPanel={() => setSidebarVisible((current) => !current)}
      windowSize={{ width: viewport.width, height: viewport.height }} leftWorkspaceWidth={LEFT_RAIL_WIDTH + (sidebarVisible ? sidebar.layout.sessionRailWidth : 0)}
      isSingleWorkspacePage={false} showSessionRail={sidebarVisible} collapseChatSessions={!sidebarVisible}
      showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={300}
      onSessionResizeMouseDown={() => undefined} onDetailResizeMouseDown={() => undefined}
      sidebar={<WorkspaceSidebar {...sidebar as unknown as WorkspaceSidebarProps} layout={{ ...sidebar.layout, collapseChatSessions: !sidebarVisible } as WorkspaceSidebarProps['layout']} />}
      mainContent={<ChatsPage layout={pageProps} session={pageProps} transcript={pageProps} composer={pageProps} runtime={pageProps} auth={pageProps} />}
    />
  </div>;
}

createRoot(document.getElementById('root')!).render(<ProviderConnectTrayPreview />);
