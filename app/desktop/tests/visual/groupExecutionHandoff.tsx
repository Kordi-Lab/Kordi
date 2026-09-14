import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { ChatPaneLayout } from '../../src/pages/ChatPaneLayout';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', 'theme-light');
const noop = () => {};
const owner = !new URLSearchParams(location.search).has('peer');
const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
  id: `history-${i}`, role: 'person', sender: 'Synthetic member', time: '12:00',
  text: `Synthetic earlier message ${i + 1}. ${'Context stays in the conversation during a follow-up. '.repeat(5)}`,
}));
function Fixture() {
  const [phase, setPhase] = useState<'running' | 'complete' | 'public'>('running');
  const [draft, setDraft] = useState('Keep this draft');
  const tools = phase === 'public' ? [] : ['one', 'two'].map((id) => ({
    id: `read-${id}`, name: 'read', status: phase === 'running' ? 'running' : 'complete',
    arguments: JSON.stringify({ path: `synthetic-${id}.md` }), liveOutput: 'Synthetic private tool output', isError: false,
  }));
  const messages: Message[] = [...history, { id: 'request', role: 'user', text: 'Synthetic follow-up', time: '12:01' }, {
    id: 'group-response', role: owner ? 'owned-agent' : 'external-agent', sender: 'Synthetic Agent', time: '12:02', text: '',
    turn: { id: 'canonical-turn:group-response', sessionId: 'synthetic-group', prompt: '',
      status: phase === 'running' ? 'using-tool' : 'complete', message: '', assistantText: 'Public answer',
      thinkingText: '', tools, completed: phase !== 'running', succeeded: phase !== 'running' },
  }];
  return <>
    <div style={{ position: 'fixed', right: 30, top: 12, zIndex: 1000 }}>
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
