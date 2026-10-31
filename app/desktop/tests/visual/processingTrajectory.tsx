import { directReplyHandoffMessages } from './directReplyHandoff';
import { CompanionDocumentPane } from '../../src/pages/chatsPage.companionDocument';
import { useCompanionDocument, useCompanionDocumentRequests } from '../../src/features/documents/useCompanionDocument';
import { openTranscriptFile } from '../../src/features/documents/companionDocument';
import { PinMotionFixture } from './pinMotionFixture';
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

const startup = new URLSearchParams(location.search).has('startup');
const simple = new URLSearchParams(location.search).has('simple');
const reasoning = new URLSearchParams(location.search).has('reasoning');
const ordered = new URLSearchParams(location.search).has('ordered');
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
  const [phase, setPhase] = useState(Number(new URLSearchParams(location.search).get('phase') ?? 0));
  const tabs = useCompanionDocument('synthetic-preview');
  useCompanionDocumentRequests(document => tabs.open({ ...document, readLocally: false, preview: { path: document.artifact.path, truncated: false, lines: [{ number: 1, text: 'export const example = true;' }, { number: 2, text: '// Synthetic source for the interactive preview.' }] } }));
  const [draft, setDraft] = useState('Synthetic request');
  useLayoutEffect(() => {
    driver.step = next => { if (next === 1) { setDraft(''); scheduleTranscriptScrollToBottom(scrollRef); } setPhase(next); };
  }, []);
  const tools = !simple && phase >= 6 ? [{ id: 'tool-one', name: 'read', status: phase === 6 ? 'running' : 'done', arguments: '{"path":"src/example.ts"}', liveOutput: 'Synthetic result', isError: false }] : [];
  if (ordered && !simple && phase >= 7) tools.push({ id: 'tool-two', name: 'edit', status: phase === 7 ? 'running' : 'done', arguments: '{"path":"src/updated.ts"}', liveOutput: 'Updated the example.', isError: false });
  const segments: DesktopChatTurnSnapshot['segments'] = simple ? [{ id: 'text:0', kind: 'text', text: 'Hello. How can I help?' }] : ordered && phase >= 5 ? [
    { id: 'text:0', kind: 'text', text: 'I will inspect the example before making a change.' },
    ...(phase >= 6 ? [{ id: 'tool:one', kind: 'tool' as const, toolId: 'tool-one' }] : []),
    ...(phase >= 7 ? [{ id: 'text:2', kind: 'text' as const, text: 'The example needs one change. I will apply it now.' }, { id: 'tool:two', kind: 'tool' as const, toolId: 'tool-two' }] : []),
    ...(phase >= 8 ? [{ id: 'text:4', kind: 'text' as const, text: 'The example is ready. The check passed.' }] : []),
  ] : undefined;
  const turn: DesktopChatTurnSnapshot = { id: 'local-turn', sessionId: `${cloudGroupAgentRuntimeSessionId('acct_owner', 'group')}:request:request`, replyToMessageId: 'request',
    prompt: '', status: phase === 4 ? 'starting' : phase === 5 || phase === 7 ? 'streaming' : phase === 6 ? 'tooling' : phase === 8 ? 'writing' : 'complete',
    message: '', thinkingText: reasoning ? '**Checking the request.**' : '', segments, completedAtMs: phase >= 9 ? now + 12000 : null, assistantText: phase >= 8 ? 'Synthetic final answer that fits on one line.' : '', tools, completed: phase >= 9, succeeded: phase >= 9, startedAtMs: now };
  if (new URLSearchParams(location.search).has('missingTiming')) { turn.startedAtMs = null; turn.completedAtMs = null; }
  const canonical = { profile: { id: 'profile', humanIdentityId: 'human:owner' },
    identities: [{ id: 'agent:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Synthetic Agent' }],
    sessions: [{ id: 'group', kind: 'group', title: 'Synthetic group', status: 'active', createdAtMs: now - 100000, updatedAtMs: now, metadata: {} }],
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    messages: [{ id: 'processing-slot', sessionId: 'group', senderIdentityId: 'agent:owner', senderRole: 'owned-agent', messageKind: 'agent-turn',
      sourceTransport: 'cloud-group-agent', parentMessageId: 'request', createdAtMs: now, updatedAtMs: now, sequenceNum: count + 2,
      status: phase === 2 ? 'queued' : phase >= 10 ? 'received' : 'processing', contentText: phase >= 10 ? turn.assistantText : '',
      content: { requestId: 'request', sourceConversationId: 'cloud-group-agent:group', senderOwnerAccountId: 'acct_owner', deliveryState: phase === 2 ? 'queued' : phase >= 10 ? 'complete' : 'processing', ...(phase >= 10 ? { tools, segments } : {}) } }],
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
  const response = readModel.messages('group').map(message => startup && phase >= 3 ? {
    ...message, turn: { ...turn, status: phase === 3 ? 'processing' : turn.status,
      localExecutionStarted: true,
      // Admission and the first empty stream event precede visible output.
      segments: phase === 5 ? [{ id: 'text:0', kind: 'text' as const, text: '' }] : phase < 7 ? undefined : segments,
      thinkingText: phase === 6 ? 'Checking the request.' : '', tools: phase < 7 ? [] : tools,
    },
  } : message);
  const messages: Message[] = new URLSearchParams(location.search).has('directHandoff')
    ? [...history, ...directReplyHandoffMessages(phase, now, new URLSearchParams(location.search).get('directHandoff') === 'local')]
    : [...history, ...(phase >= 1 ? [{ id: 'request', clientMessageId: 'request', role: 'user' as const, sender: 'Me', text: 'Synthetic request', time: '12:01', timestampMs: now, statusChips: [phase === 1 ? 'sending' : 'delivered'] }] : []), ...(phase >= 2 ? response : [])];
  return <>
    <div data-testid="phase" style={{ position: 'fixed', top: 0, right: 30, zIndex: 1000 }}>{phases[phase]}</div>
    <AppShellFrame rootThemeClass="theme-light" isNativeShell isLayoutResizing={false} windowSize={{ width: 1440, height: 1040 }} leftWorkspaceWidth={320}
      isSingleWorkspacePage={false} showSessionRail collapseChatSessions={false} showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
      onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
      sidebar={<aside data-testid="sidebar" className="app-side-shell flex h-full"><nav style={{ width: 72 }}>Chats</nav><div className="app-session-panel flex-1">Synthetic group</div></aside>}
      mainContent={<div className="flex h-full min-w-0 flex-1"><div className="flex min-w-0 flex-1"><ChatPaneLayout hasHeader>
        <header data-testid="header" className="app-page-header app-chat-pane-header">Synthetic group</header>
        <ChatSessionPane viewport={{ sessionKey: coldProjection ? conversation.id : 'group', messages, scrollRef, scrollClassName: 'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain',
          composer: <textarea data-testid="composer" aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} /> }}
          presentation={{ liveTurnSender: 'Synthetic Agent', shouldRenderLiveTurn: false }}
          actions={{ onOpenSource: noop, onOpenArtifact: path => { openTranscriptFile(path); }, onOpenAuthSettings: noop, onStopCollaborationAgentRequest: noop }} selection={{}} />
      </ChatPaneLayout></div>{tabs.document ? <div style={{ width: 440, minWidth: 0, borderLeft: '1px solid var(--app-control-border)' }}><CompanionDocumentPane tabs={tabs} host={{ viewer: null, sessionId: 'synthetic-preview', agentName: null, people: [] }} onClose={tabs.close} /></div> : null}</div>} />
  </>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('pin-motion') ? <PinMotionFixture /> : <Fixture />);
