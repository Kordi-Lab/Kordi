import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot } from '../../src/kordi-app/types';
import '../../src/index.css';

const initial: DesktopChatTurnSnapshot = {
  id: 'group-turn', sessionId: 'group-session', prompt: '', status: 'analyzing', message: '',
  assistantText: 'Public reply', thinkingText: 'Synthetic private reasoning', tools: [], completed: false, succeeded: false,
};
function Fixture() {
  const [owner, setOwner] = useState(!new URLSearchParams(location.search).has('peer'));
  const [turn, setTurn] = useState(initial);
  return <main style={{ width: 800 }} data-viewer={owner ? 'owner' : 'peer'}>
    <button onClick={() => setTurn({ ...initial, thinkingText: '' })}>Public progress</button>
    <button onClick={() => setTurn({ ...initial, thinkingText: '', completed: true, succeeded: true, status: 'complete' })}>Complete response</button>
    <button onClick={() => setOwner(false)}>View as peer</button>
    <button onClick={() => setTurn({ ...initial, id: 'next-turn', thinkingText: '' })}>Next request</button>
    <MessageBubble msg={{ id: 'group-reply', role: owner ? 'owned-agent' : 'external-agent', sender: 'Synthetic Agent', text: '', time: '12:00', turn }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
