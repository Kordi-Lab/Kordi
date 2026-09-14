import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { ChatPaneLayout } from '../../src/pages/ChatPaneLayout';
import { projectCloudGroupLiveTurns } from '../../src/features/cloud/cloudGroupLiveProjection';
import { cloudGroupAgentRuntimeSessionId } from '../../src/features/cloud/cloudAgentRuntime';
import { createCanonicalSessionReadModel } from '../../src/features/canonical/sessionReadModel';
import type { CanonicalSessionState, DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', 'theme-light');
const noop = () => {};
const startedAtMs = Date.now() - 180_000;
const owner = !new URLSearchParams(location.search).has('peer');
const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
  id: `history-${i}`, role: 'person', sender: 'Synthetic member', time: '12:00',
  text: `Synthetic earlier message ${i + 1}. ${'Context stays in the conversation during a follow-up. '.repeat(5)}`,
}));
function Fixture() {
  const [phase, setPhase] = useState<'waiting' | 'tools' | 'stalled' | 'text' | 'complete' | 'public'>('waiting');
  const [draft, setDraft] = useState('Keep this draft');
  const random = new URLSearchParams(location.search).has('random');
  const completed = phase === 'complete' || phase === 'public';
  const answer = phase === 'text' || completed ? 'Synthetic answer that remains visible through synchronization.' : '';
  const tools = random || phase === 'waiting' ? [] : [{
    id: 'read-one', name: 'read', status: 'done', arguments: '{"path":"synthetic.md"}',
    liveOutput: 'Synthetic first tool output', isError: false,
  }, ...(phase === 'stalled' ? [{ id: 'next-call', name: 'bash', status: 'running', arguments: '{', liveOutput: '', isError: false }] : [])];
  const live: DesktopChatTurnSnapshot = {
    id: 'native-turn', sessionId: `${cloudGroupAgentRuntimeSessionId('owner', 'synthetic-group')}:request:request`,
    replyToMessageId: 'request', prompt: '', status: completed ? 'complete' : tools.length ? 'using-tool' : 'analyzing',
    message: '', assistantText: answer, thinkingText: '', tools, completed, succeeded: completed,
    startedAtMs, ...(completed ? { completedAtMs: startedAtMs + 180_000 } : {}),
  };
  const canonical = {
    profile: { id: 'profile', humanIdentityId: owner ? 'human:owner' : 'human:peer' },
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    identities: [{ id: 'agent:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Synthetic Agent' }],
    sessions: [{ id: 'synthetic-group', kind: 'group', title: 'Synthetic group', status: 'active', createdAtMs: startedAtMs, updatedAtMs: startedAtMs, metadata: {} }],
    messages: [{ id: 'group-response', sessionId: 'synthetic-group', senderIdentityId: 'agent:owner', senderRole: owner ? 'owned-agent' : 'external-agent',
      messageKind: 'agent-turn', parentMessageId: 'request', sourceTransport: 'cloud-group-agent',
      status: phase === 'public' ? 'received' : 'processing', contentText: phase === 'public' ? answer : '',
      content: { deliveryState: phase === 'public' ? 'complete' : 'processing', requestId: 'request',
        ...(phase === 'public' ? { tools: owner ? tools : [], startedAtMs, completedAtMs: startedAtMs + 180_000 } : {}) }, createdAtMs: startedAtMs, updatedAtMs: startedAtMs, sequenceNum: 2 }],
  } as CanonicalSessionState;
  const projected = projectCloudGroupLiveTurns(canonical, { request: live }, 'owner')!;
  const response = createCanonicalSessionReadModel(projected).messages('synthetic-group')[0];
  const messages: Message[] = [...history, { id: 'request', role: 'user', text: 'Synthetic request', time: '12:01' }, response];
  return <>
    <div style={{ position: 'fixed', right: 30, top: 12, zIndex: 1000 }}>
      <button onClick={() => setPhase('tools')}>Tool progress</button>
      <button onClick={() => setPhase('stalled')}>Preparing next call</button>
      <button onClick={() => setPhase('text')}>Answer text</button>
      <button onClick={() => setPhase('complete')}>Local completion</button>
      <button onClick={() => setPhase('public')}>Public sync</button>
    </div>
    <AppShellFrame rootThemeClass="theme-light" isNativeShell isLayoutResizing={false}
      windowSize={{ width: 1480, height: 980 }} leftWorkspaceWidth={320}
      isSingleWorkspacePage={false} showSessionRail collapseChatSessions={false}
      showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
      onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
      sidebar={<aside data-testid="sidebar" className="app-side-shell flex h-full"><nav style={{ width: 72 }}>Chats</nav><div className="app-session-panel flex-1">Synthetic group</div></aside>}
      mainContent={<ChatPaneLayout hasHeader>
        <header data-testid="header" className="app-page-header app-chat-pane-header">Synthetic group</header>
        <div className="flex min-h-0 flex-1 flex-col">
          <VirtualTranscript items={messages} sessionKey="synthetic-group" getItemKey={message => message.id!}
            estimateSize={() => 150} scrollClassName="min-h-0 flex-1" renderItem={message => <MessageBubble msg={message} />} />
          <textarea data-testid="composer" aria-label="Message" className="shrink-0" value={draft} onChange={e => setDraft(e.target.value)} />
        </div>
      </ChatPaneLayout>} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
