import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShellFrame } from '../../src/app/AppShellFrame';
import {
  currentMentionQuery,
  filterMentionTargets,
} from '../../src/app/useKordiAppModelHelpers';
import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import type { ComposerMentionOption } from '../../src/kordi-app/components';
import type { Conversation, Message } from '../../src/kordi-app/types';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { loadLinkPreviewMetadata } from '../../src/kordi-app/components/linkPreviewMetadata';
import { ChatsPage } from '../../src/pages/ChatsPage';
import type { ChatsPageProps } from '../../src/pages/chatsPage.types';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from '../../src/pages/WorkspaceSidebar';
import { cloudAccountAvatarFixture } from '../helpers/cloudAccountAvatarFixture';
import { baseSidebarProps } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

const groupSessionId = 'session:group:preview-human-all';
const broadcastText = '@all The mobile review is ready. Please check your section before 16:00.';
const themeContrastPreview = new URLSearchParams(window.location.search).has('themeContrast');
const replyContrastPreview = themeContrastPreview || new URLSearchParams(window.location.search).has('replyContrast');
type PreviewAppearance = 'light' | 'dark';
type PreviewChatTheme = 'default' | 'quiet' | 'midnight' | 'sand' | 'ocean';
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
      showSenderMeta: true,
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
      role: 'person',
      sender: 'Maya Chen',
      senderIdentityId: 'human:acct_preview_maya',
      senderType: 'human',
      showSenderMeta: true,
      text: 'The settings screenshots will follow in the same thread.',
      time: '15:43',
      timestampMs: 1_786_443_780_000,
    },
    {
      id: 'msg:preview:3',
      role: 'person',
      sender: 'Jordan Lee',
      senderIdentityId: 'human:acct_preview_jordan',
      senderType: 'human',
      showSenderMeta: true,
      text: 'I checked the compact layout on the smaller display.',
      time: '15:44',
      timestampMs: 1_786_443_840_000,
    },
    {
      id: 'msg:preview:4',
      role: 'person',
      sender: 'Jordan Lee',
      senderIdentityId: 'human:acct_preview_jordan',
      senderType: 'human',
      showSenderMeta: true,
      text: 'The sender label only appears on my first bubble.',
      time: '15:45',
      timestampMs: 1_786_443_900_000,
    },
    {
      id: 'msg:preview:5',
      role: 'user',
      sender: 'Me',
      senderIdentityId: 'human:acct_preview_self',
      senderType: 'human',
      text: 'I’ll review the release notes and reply here.',
      time: '15:46',
      timestampMs: 1_786_443_960_000,
    },
    {
      id: 'msg:preview:6',
      role: 'user',
      sender: 'Me',
      senderIdentityId: 'human:acct_preview_self',
      senderType: 'human',
      text: 'Review the updated colors at https://kordi.ai.',
      time: '15:47',
      timestampMs: 1_786_444_020_000,
      replyToMessageId: 'msg:preview:1',
      sourceMessage: {
        messageId: 'msg:preview:1',
        senderLabel: 'Maya Chen',
        text: broadcastText,
        mentions: [{
          label: 'all',
          targetKind: 'all',
          targetIdentityId: `group:${groupSessionId}`,
          startUtf16: 0,
          lengthUtf16: 4,
          displayText: '@all',
          displayLabel: 'All',
        }],
        attachmentCount: 0,
        time: '15:42',
      },
      messageAction: {
        schemaVersion: 1,
        kind: 'quote',
        source: {
          sourceSessionId: groupSessionId,
          sourceMessageId: 'msg:preview:1',
          senderLabel: 'Maya Chen',
          textPreview: broadcastText,
          mentions: [{
            label: 'all',
            targetKind: 'all',
            targetIdentityId: `group:${groupSessionId}`,
            startUtf16: 0,
            lengthUtf16: 4,
            displayText: '@all',
            displayLabel: 'All',
          }],
          attachmentCount: 0,
        },
      },
    },
    {
      id: 'msg:preview:7',
      role: 'person',
      sender: 'Maya Chen',
      senderIdentityId: 'human:acct_preview_maya',
      senderType: 'human',
      showSenderMeta: true,
      text: 'The link and reply stay readable in every theme: https://kordi.ai.',
      time: '15:48',
      timestampMs: 1_786_444_080_000,
      replyToMessageId: 'msg:preview:6',
      sourceMessage: {
        messageId: 'msg:preview:6',
        senderLabel: 'Alex Morgan',
        text: 'Review the updated colors at https://kordi.ai.',
        attachmentCount: 0,
        time: '15:47',
      },
      messageAction: {
        schemaVersion: 1,
        kind: 'quote',
        source: {
          sourceSessionId: groupSessionId,
          sourceMessageId: 'msg:preview:6',
          senderLabel: 'Alex Morgan',
          textPreview: 'Review the updated colors at https://kordi.ai.',
          attachmentCount: 0,
        },
      },
    },
  ],
  updatedAtLabel: '15:48',
};

const contrastMessages: Message[] = [
  {
    id: 'contrast-url-own', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
    text: '@Maya @Assistant Review the color study: https://example.com/color-study',
    time: '11:01', statusChips: ['read'],
    mentions: [{ label: 'Maya', targetKind: 'person' }, { label: 'Assistant', targetKind: 'agent' }],
    replySummary: { replyCount: 2, targetMessageId: 'contrast-url-peer' },
  },
  {
    id: 'contrast-url-peer', role: 'person', sender: 'Maya Chen', senderType: 'human', showSenderMeta: true,
    text: '@Alex Here is the preview reference: https://example.org/interface-review',
    time: '11:02', mentions: [{ label: 'Alex', targetKind: 'person' }],
  },
  {
    id: 'contrast-url-label', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
    text: 'You can also open [the review checklist](https://example.net/review-checklist) from an inline text link.',
    time: '11:03', statusChips: ['delivered'],
  },
  {
    id: 'contrast-peer', role: 'person', sender: 'Maya Chen', senderType: 'human',
    showSenderMeta: true, text: '@Alex @Assistant Please review the mention and receipt colors.',
    time: '11:06', mentions: [{ label: 'Alex', targetKind: 'person' }, { label: 'Assistant', targetKind: 'agent' }],
  },
  ...['sent', 'delivered', 'read', 'responded', 'sending', 'processing', 'failed', 'partial'].map((status, index): Message => ({
    id: `contrast-${status}`, role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
    text: `@Maya @Assistant ${status === 'read' ? 'Can you check the resource usage on my laptop?' : `This message shows the ${status} state.`}`,
    time: `11:${String(7 + index).padStart(2, '0')}`, statusChips: [status],
    mentions: [{ label: 'Maya', targetKind: 'person' }, { label: 'Assistant', targetKind: 'agent' }],
    replySummary: { replyCount: index + 1, targetMessageId: 'contrast-peer' },
  })),
  {
    id: 'contrast-all', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
    text: '@all The contrast review is ready. This longer message wraps onto a second line so you can inspect the mentions and footer in a larger bubble.',
    time: '11:16', statusChips: ['read'], mentions: [{ label: 'all', targetKind: 'all' }],
    replySummary: { replyCount: 12, targetMessageId: 'contrast-peer' },
  },
];
if (themeContrastPreview) {
  previewConversation.name = 'Theme contrast review';
  previewConversation.subtitle = 'Synthetic conversation';
  previewConversation.messages = contrastMessages;
}

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
  useEffect(() => {
    if (themeContrastPreview) document.title = 'Kordi — Theme contrast review';
  }, []);
  const [draft, setDraft] = useState(replyContrastPreview ? '' : '@');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [appearance, setAppearance] = useState<PreviewAppearance>('light');
  const [chatTheme, setChatTheme] = useState<PreviewChatTheme>(themeContrastPreview ? 'sand' : 'quiet');
  const [componentView, setComponentView] = useState(themeContrastPreview);
  useEffect(() => {
    document.body.dataset.kordiChatTheme = chatTheme;
  }, [chatTheme]);
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
    chatMentionTargetsForText: (text: string, cursor?: number) => filterMentionTargets(
      mentionTargets,
      currentMentionQuery(text, cursor),
    ),
    chatSlashMenuIndex: mentionIndex,
    setChatSlashMenuIndex: setMentionIndex,
    acceptChatSlashCommand: () => undefined,
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
    <>
      {replyContrastPreview ? (
        <div className="fixed right-[150px] top-2.5 z-[100] flex items-center gap-2 rounded-[10px] border border-slate-300 bg-white/95 p-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
          {themeContrastPreview ? <>
            <span className="px-2">Synthetic data</span>
            <button type="button" aria-pressed={!componentView} onClick={() => setComponentView(false)} className="rounded-md border border-slate-300 px-2 py-1">Conversation</button>
            <button type="button" aria-pressed={componentView} onClick={() => setComponentView(true)} className="rounded-md border border-slate-300 px-2 py-1">Components</button>
          </> : null}
          <label className="flex items-center gap-1.5">
            Appearance
            <select
              aria-label="Preview appearance"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900"
              value={appearance}
              onChange={(event) => setAppearance(event.target.value as PreviewAppearance)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Chat theme
            <select
              aria-label="Preview chat theme"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900"
              value={chatTheme}
              onChange={(event) => setChatTheme(event.target.value as PreviewChatTheme)}
            >
              <option value="default">Default</option>
              <option value="quiet">Quiet</option>
              <option value="midnight">Midnight</option>
              <option value="sand">Sand</option>
              <option value="ocean">Ocean</option>
            </select>
          </label>
        </div>
      ) : null}
      <AppShellFrame
        rootThemeClass={`theme-${appearance}`}
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
        mainContent={componentView ? <div className="app-chat-theme-surface h-full overflow-y-auto p-8" data-contrast-components>
          <div className="mb-6 pt-5 text-[18px] font-semibold">Message components</div>
          <p className="mb-6 text-[13px]">Mint person mentions · Sky agent mentions · Gold replies and delivery · Mint read receipts. These are the app’s current theme colors.</p>
          <div className="flex flex-col gap-8">{contrastMessages.map(message => <section key={message.id}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide">{message.id === 'contrast-url-own' ? 'Outgoing URL + preview card' : message.id === 'contrast-url-peer' ? 'Received URL + preview card' : message.id === 'contrast-url-label' ? 'Inline text link + preview card' : message.statusChips?.[0] ?? 'Received message'}</div>
            <MessageBubble msg={message} />
          </section>)}</div>
        </div> : <ChatsPage layout={pageProps} session={pageProps} transcript={pageProps} composer={pageProps} runtime={pageProps} auth={pageProps} />}
      />
    </>
  );
}

async function renderPreview() {
  if (themeContrastPreview) {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 240;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#854627';
    context.fillRect(0, 0, 360, 240);
    ['#78efb5', '#99dfff', '#ffdf80'].forEach((color, index) => {
      context.fillStyle = color;
      context.fillRect(36 + index * 100, 50, 82, 140);
    });
    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const previews = [
      { href: 'https://example.com/color-study', title: 'Mint, sky, and gold — color study', siteName: 'Design notebook' },
      { href: 'https://example.org/interface-review', title: 'An interface with a little more color', siteName: 'Team review' },
      { href: 'https://example.net/review-checklist', title: 'Chat theme review checklist', siteName: 'Design notes' },
    ];
    await Promise.all(previews.map(preview => loadLinkPreviewMetadata(preview.href, async <T,>() => ({
      title: preview.title, siteName: preview.siteName,
      description: 'Synthetic link-preview content for this local design review.',
      imageUrl: null, imageDataUrl,
    }) as T)));
  }
  createRoot(document.querySelector('#root')!).render(<GroupMentionPreview />);
}
void renderPreview();
