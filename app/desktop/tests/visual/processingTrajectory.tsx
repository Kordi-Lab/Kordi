import { createRef, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { ChatPaneLayout } from '../../src/pages/ChatPaneLayout';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { scheduleTranscriptScrollToBottom } from '../../src/pages/chatsPage.header';
import { buildCloudDesktopCollaborationState } from '../../src/features/cloud/cloudCollaborationState';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../../src/features/cloud/cloudGroupMessages';
import { mapCollaborationConversationToViewModel } from '../../src/features/collaboration/transcript';
import { cloudAccountAvatarFixture } from '../helpers/cloudAccountAvatarFixture';
import type { CloudAccount, CloudMessage } from '../../src/features/cloud/authClient';
import { createCanonicalSessionReadModel } from '../../src/features/canonical/sessionReadModel';
import { projectCloudGroupLiveTurns } from '../../src/features/cloud/cloudGroupLiveProjection';
import { cloudGroupAgentRuntimeSessionId } from '../../src/features/cloud/cloudAgentRuntime';
import type { CanonicalSessionState, DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const count = Number(new URLSearchParams(location.search).get('count') ?? 50);
const now = Date.now();
const coldProjection = new URLSearchParams(location.search).has('cold');
const account: CloudAccount = { accountId: 'acct_owner', displayName: 'Owner', primaryEmail: 'owner@example.invalid', avatar: cloudAccountAvatarFixture, avatarUrl: null, nodeId: null, passwordSet: true };
const history: Message[] = Array.from({ length: count }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'person' : 'user', sender: i % 2 ? 'Synthetic member' : 'Me',
  text: `Earlier message ${i + 1}. ${'Conversation history remains in place. '.repeat(3 + i % 4)}`, time: '12:00', timestampMs: now - (count - i) * 1000, statusChips: ['delivered'] }));
const scrollRef = createRef<HTMLDivElement>();
const noop = () => {};
const phases = ['idle', 'send', 'ack', 'processing', 'starting', 'streaming', 'tool', 'next-iteration', 'answer', 'complete', 'public'];
const driver = { step: (_phase: number) => {} };
Object.assign(window, { processingTrajectory: driver });
document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', 'theme-light');
function Fixture() {
  const [phase, setPhase] = useState(0);
  const [draft, setDraft] = useState('Synthetic request');
  useLayoutEffect(() => {
    driver.step = next => { if (next === 1) { setDraft(''); scheduleTranscriptScrollToBottom(scrollRef); } setPhase(next); };
  }, []);
  const tools = phase >= 6 ? [{ id: 'tool-one', name: 'read', status: phase === 6 ? 'running' : 'done', arguments: '{"path":"synthetic.md"}', liveOutput: 'Synthetic result', isError: false }] : [];
  const turn: DesktopChatTurnSnapshot = { id: 'local-turn', sessionId: `${cloudGroupAgentRuntimeSessionId('acct_owner', 'group')}:request:request`, replyToMessageId: 'request',
    prompt: '', status: phase === 4 ? 'starting' : phase === 5 || phase === 7 ? 'streaming' : phase === 6 ? 'tooling' : phase === 8 ? 'writing' : 'complete',
    message: '', thinkingText: '', assistantText: phase >= 8 ? 'Synthetic final answer that fits on one line.' : '', tools, completed: phase >= 9, succeeded: phase >= 9, startedAtMs: now };
  const canonical = { profile: { id: 'profile', humanIdentityId: 'human:owner' },
    identities: [{ id: 'agent:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Synthetic Agent' }],
    sessions: [{ id: 'group', kind: 'group', title: 'Synthetic group', status: 'active', createdAtMs: now - 100000, updatedAtMs: now, metadata: {} }],
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    messages: [{ id: 'processing-slot', sessionId: 'group', senderIdentityId: 'agent:owner', senderRole: 'owned-agent', messageKind: 'agent-turn',
      sourceTransport: 'cloud-group-agent', parentMessageId: 'request', createdAtMs: now, updatedAtMs: now, sequenceNum: count + 2,
      status: phase === 2 ? 'queued' : phase >= 10 ? 'received' : 'processing', contentText: phase >= 10 ? turn.assistantText : '',
      content: { requestId: 'request', sourceConversationId: 'cloud-group-agent:group', senderOwnerAccountId: 'acct_owner', deliveryState: phase === 2 ? 'queued' : phase >= 10 ? 'complete' : 'processing', ...(phase >= 10 ? { tools } : {}) } }],
  } as CanonicalSessionState;
  const projected = projectCloudGroupLiveTurns(canonical, phase >= 4 ? { request: turn } : {}, 'acct_owner')!;
  const readModel = createCanonicalSessionReadModel(projected)!;
  const wire: CloudMessage = {
    messageId: 'self-processing-control', fromAccountId: 'acct_owner', toAccountId: 'acct_owner', sessionId: 'group', conversationId: 'group',
    direction: 'outgoing', createdAt: new Date(now).toISOString(), deliveredAt: null, readAt: null,
    body: encodeCloudGroupControl({ kind: 'group-message', groupId: 'group', groupTitle: 'Synthetic group', createdByAccountId: 'acct_owner',
      actor: { accountId: 'acct_owner', displayName: 'Owner', role: 'person' }, participants: [{ accountId: 'acct_owner', displayName: 'Owner', role: 'person' }],
      message: { id: 'processing-slot', senderAccountId: 'acct_owner', senderKind: 'agent', text: '', deliveryState: 'processing', requestId: 'request', createdAtMs: now } }),
  };
  if (!parseCloudGroupControl(wire.body)) throw new Error('Expected a valid synthetic group control');
  const cloud = buildCloudDesktopCollaborationState({ account, contacts: [], messagesByPeer: coldProjection && phase >= 4 ? { acct_owner: [wire] } : {} });
  const sources = cloud.conversations.map(conversation => mapCollaborationConversationToViewModel(conversation, cloud.hosts[0], 'Synthetic Agent'));
  const conversation = readModel.buildChatConversations(sources, () => '')[0];
  const response = readModel.messages('group');
  const messages: Message[] = [...history, ...(phase >= 1 ? [{ id: 'request', clientMessageId: 'request', role: 'user' as const, sender: 'Me', text: 'Synthetic request', time: '12:01', timestampMs: now, statusChips: [phase === 1 ? 'sending' : 'delivered'] }] : []), ...(phase >= 2 ? response : [])];
  return <>
    <div data-testid="phase" style={{ position: 'fixed', top: 0, right: 30, zIndex: 1000 }}>{phases[phase]}</div>
    <AppShellFrame rootThemeClass="theme-light" isNativeShell isLayoutResizing={false} windowSize={{ width: 1440, height: 1040 }} leftWorkspaceWidth={320}
      isSingleWorkspacePage={false} showSessionRail collapseChatSessions={false} showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
      onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
      sidebar={<aside data-testid="sidebar" className="app-side-shell flex h-full"><nav style={{ width: 72 }}>Chats</nav><div className="app-session-panel flex-1">Synthetic group</div></aside>}
      mainContent={<ChatPaneLayout hasHeader>
        <header data-testid="header" className="app-page-header app-chat-pane-header">Synthetic group</header>
        <ChatSessionPane viewport={{ sessionKey: coldProjection ? conversation.id : 'group', messages, scrollRef, scrollClassName: 'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain',
          composer: <textarea data-testid="composer" aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} /> }}
          presentation={{ liveTurnSender: 'Synthetic Agent', shouldRenderLiveTurn: false }}
          actions={{ onOpenSource: noop, onOpenArtifact: noop, onOpenAuthSettings: noop, onStopCollaborationAgentRequest: noop }} selection={{}} />
      </ChatPaneLayout>} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
