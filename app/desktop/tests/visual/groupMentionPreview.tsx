import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShellFrame } from '../../src/app/AppShellFrame';
import {
  currentMentionQuery,
  filterMentionTargets,
} from '../../src/app/useKordiAppModelHelpers';
import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { insertMentionIntoDraft } from '../../src/features/chat/messageActions/mentions';
import type { ComposerMentionOption } from '../../src/kordi-app/components';
import type { Conversation } from '../../src/kordi-app/types';
import { ChatsPage } from '../../src/pages/ChatsPage';
import type { ChatsPageProps } from '../../src/pages/chatsPage.types';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from '../../src/pages/WorkspaceSidebar';
import { cloudAccountAvatarFixture } from '../helpers/cloudAccountAvatarFixture';
import { baseSidebarProps } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

const groupSessionId = 'session:group:preview-human-all';
const broadcastText = '@all The mobile review is ready. Please check your section before 16:00.';
const previewConversation: Conversation = {
  id: groupSessionId,
  canonicalSessionId: groupSessionId,
  name: 'Mobile builders',
  type: 'owned-agent',
  subtitle: '3 people · Group chat',
  unread: 1,
  unreadMentions: 1,
  collaborationSources: ['Cloud'],
  trust: 'Cloud',
  directness: 'Group chat',
  participantSpaceId: 'group:preview-human-all',
  participants: ['Alex Morgan', 'Maya Chen', 'Jordan Lee'],
  canonicalParticipants: [
    { id: 'human:acct_preview_self', humanId: 'acct_preview_self', name: 'Alex Morgan', kind: 'human', role: 'self', source: 'local', avatarKey: 'alex-preview' },
    { id: 'human:acct_preview_maya', humanId: 'acct_preview_maya', name: 'Maya Chen', kind: 'human', role: 'member', source: 'cloud', avatarKey: 'maya-preview' },
    { id: 'human:acct_preview_jordan', humanId: 'acct_preview_jordan', name: 'Jordan Lee', kind: 'human', role: 'member', source: 'cloud', avatarKey: 'jordan-preview' },
  ],
  messages: [
    {
      id: 'msg:preview:1',
      role: 'person',
      sender: 'Maya Chen',
      senderIdentityId: 'human:acct_preview_maya',
      senderType: 'human',
      text: broadcastText,
      time: '15:42',
      timestampMs: 1_786_443_720_000,
      mentions: [{
        label: 'all',
        targetKind: 'all',
        targetIdentityId: `group:${groupSessionId}`,
        startUtf16: 0,
        lengthUtf16: 4,
        displayText: '@all',
        displayLabel: 'All',
      }],
    },
    {
      id: 'msg:preview:2',
      role: 'user',
      sender: 'Me',
      senderIdentityId: 'human:acct_preview_self',
      senderType: 'human',
      text: 'I’ll review the release notes and reply here.',
      time: '15:44',
      timestampMs: 1_786_443_840_000,
    },
  ],
  updatedAtLabel: '15:44',
};

const mentionTargets: ComposerMentionOption[] = [
  {
    value: 'all',
    label: 'All',
    detail: 'All people in this group',
    targetKind: 'all',
    sourceHostId: 'conversation',
    nodeId: `group:${groupSessionId}`,
    runtime: 'group',
  },
  {
    value: 'MayaChen',
    label: 'Maya Chen',
    detail: 'Person',
    targetKind: 'person',
    sourceHostId: 'cloud',
    nodeId: 'acct_preview_maya',
    runtime: 'person',
    humanId: 'acct_preview_maya',
    avatarSeed: 'maya-preview',
  },
  {
    value: 'JordanLee',
    label: 'Jordan Lee',
    detail: 'Person',
    targetKind: 'person',
    sourceHostId: 'cloud',
    nodeId: 'acct_preview_jordan',
    runtime: 'person',
    humanId: 'acct_preview_jordan',
    avatarSeed: 'jordan-preview',
  },
];

const participantSpaces = buildParticipantSpaces([previewConversation]);
const previewAccount = {
  accountId: 'acct_preview_self',
  kordiId: '704218563',
  displayName: 'Alex Morgan',
  primaryEmail: 'alex.preview@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_preview_self',
  passwordSet: true,
};

type PreviewChatsPageProps = ChatsPageProps['layout']
  & ChatsPageProps['session']
  & ChatsPageProps['transcript']
  & ChatsPageProps['composer']
  & ChatsPageProps['runtime']
  & ChatsPageProps['auth'];

function GroupMentionPreview() {
  const [draft, setDraft] = useState('@');
  const [mentionIndex, setMentionIndex] = useState(0);
  const filteredMentionTargets = filterMentionTargets(
    mentionTargets,
    currentMentionQuery(draft),
  );
  const acceptMention = (value: string) => {
    setDraft((current) => insertMentionIntoDraft(current, value));
    setMentionIndex(0);
  };
  const pageProps = {
    isNativeShell: true,
    showChatDetailRail: false,
    collapseChatSessions: false,
    setIsSessionPanelCollapsed: () => undefined,
    showRightDetailRail: false,
    isDetailPanelCollapsed: true,
    setIsDetailPanelCollapsed: () => undefined,
    activeDetailTab: 'messages',
    setActiveDetailTab: () => undefined,
    activeArtifactId: null,
    setActiveArtifactId: () => undefined,
    activeConv: previewConversation,
    chatConversations: [previewConversation],
    companionConversations: [previewConversation],
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
    chatTranscriptScrollRef: { current: null },
    onTranscriptScroll: () => undefined,
    onOpenSource: () => undefined,
    onOpenArtifact: () => undefined,
    desktopLiveTurn: null,
    queuedDesktopMessages: [],
    queuedDesktopMessagesBySession: {},
    onEditQueuedMessage: () => undefined,
    onCancelQueuedMessage: () => undefined,
    filteredChatSlashCommands: [],
    filteredChatMentionTargets: filteredMentionTargets,
    chatSlashMenuIndex: mentionIndex,
    setChatSlashMenuIndex: setMentionIndex,
    acceptChatSlashCommand: () => undefined,
    acceptChatMentionTarget: acceptMention,
    chatAttachmentInputRef: { current: null },
    chatComposerAttachments: [],
    saveDesktopAttachments: async () => [],
    saveDesktopAttachmentPaths: async () => [],
    removeChatComposerAttachment: () => undefined,
    updateChatComposerAttachment: () => undefined,
    chatComposerText: draft,
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
    onSelectSession: () => undefined,
    onSendChatMessage: () => undefined,
    onCreateAgentSession: () => undefined,
    hasAnyAuth: true,
    onOpenAuthSettings: () => undefined,
    onOpenAccountAuthentication: () => undefined,
  } as unknown as PreviewChatsPageProps;
  const sidebar = baseSidebarProps({
    isNativeShell: true,
    chatConversations: [previewConversation],
    participantSpaces,
    filteredConversations: [previewConversation],
    contactParticipantSpaces: participantSpaces,
    agentParticipantSpaces: [],
    activeConvId: groupSessionId,
    cloudAccount: previewAccount,
    localProfileAvatarSeed: previewAccount.avatar.seed,
    onSelectChatSession: () => undefined,
    onPrefetchChatSession: async () => undefined,
    isCollaborationSyncing: false,
    isCollaborationSyncUnavailable: false,
  });

  return (
    <AppShellFrame
      rootThemeClass="theme-light"
      isNativeShell
      isLayoutResizing={false}
      windowSize={{ width: 1180, height: 760 }}
      leftWorkspaceWidth={330}
      isSingleWorkspacePage={false}
      showSessionRail
      collapseChatSessions={false}
      showRightDetailRail={false}
      isDetailPanelCollapsed
      detailRailWidth={320}
      onSessionResizeMouseDown={() => undefined}
      onDetailResizeMouseDown={() => undefined}
      sidebar={<WorkspaceSidebar {...sidebar as unknown as WorkspaceSidebarProps} />}
      mainContent={<ChatsPage layout={pageProps} session={pageProps} transcript={pageProps} composer={pageProps} runtime={pageProps} auth={pageProps} />}
    />
  );
}

createRoot(document.querySelector('#root')!).render(<GroupMentionPreview />);
