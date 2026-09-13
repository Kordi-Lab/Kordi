import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { suppressIncompleteLiveTurnEcho } from '../../src/features/chat/desktopLiveTurns';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const tool = (id: string) => ({ id, name: 'read', status: 'complete', arguments: '', liveOutput: '', isError: false });
const current: DesktopChatTurnSnapshot = {
  id: 'current-turn', sessionId: 'synthetic-session', prompt: 'Follow up', status: 'running',
  message: '', assistantText: '', thinkingText: '', tools: [tool('new-tool')],
  completed: false, succeeded: false,
};
const history: Message[] = [
  { id: 'old-user', role: 'user', text: 'Earlier synthetic question', time: '12:00' },
  { id: 'old-answer', role: 'owned-agent', text: 'Earlier synthetic answer', time: '12:01',
    turn: { ...current, id: 'old-turn', status: 'complete', completed: true, succeeded: true, tools: [tool('old-tool-1'), tool('old-tool-2')] } },
  { id: 'followup-user', role: 'user', text: 'Synthetic follow-up question', time: '12:02' },
];

function Fixture() {
  const [running, setRunning] = useState<DesktopChatTurnSnapshot>();
  const [complete, setComplete] = useState(false);
  const visible = suppressIncompleteLiveTurnEcho(history, running);
  const items = running || complete ? [...visible, {
    id: 'current-answer', role: 'owned-agent' as const, time: '12:03', text: complete ? 'Synthetic finished reply' : 'Synthetic working reply',
  }] : visible;
  return <main style={{ width: 800 }}>
    <button onClick={() => { setComplete(false); setRunning(current); }}>Start follow-up</button>
    <button onClick={() => setRunning({ ...current, tools: [tool('new-tool'), tool('another-new-tool')] })}>Next tool</button>
    <button onClick={() => { setRunning(undefined); setComplete(true); }}>Finish reply</button>
    <VirtualTranscript items={items} sessionKey="synthetic-session" getItemKey={message => message.id!}
      estimateSize={() => 180} scrollStyle={{ height: 600 }}
      renderItem={message => <div data-message-id={message.id} style={{ height: message.id === 'old-answer' ? 260 : 180 }}>{message.text}</div>} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
