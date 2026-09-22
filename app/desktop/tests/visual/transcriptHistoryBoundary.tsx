import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
  id: `boundary-${index}`, role: 'person', sender: 'Synthetic peer', showSenderMeta: true,
  text: `Synthetic message ${index}`, time: '10:00', timestampMs: 1_780_000_000_000 + index * 1_000,
}));
const withPins = new URLSearchParams(window.location.search).has('pins');
const pinActivities = Array.from({ length: 12 }, (_, index) => ({
  id: `historical-pin-${index}`, label: 'Synthetic peer pinned a message',
  timestampMs: messages[65 + index]!.timestampMs!,
}));
function Boundary() {
  const [start, setStart] = useState(100);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return <main className="app-chat-split-workspace" style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => setStart(value => value - 40)}>Prepend history</button>
    <button onClick={() => setExpanded(true)}>Expand first message</button>
    <ChatSessionPane viewport={{ sessionKey: 'history-boundary', messages: messages.slice(start).map((message, index) => expanded && index === 0
      ? { ...message, text: `${message.text}\n${'Additional synthetic content\n'.repeat(8)}` } : message), scrollRef,
      scrollClassName: 'app-chat-pane-transcript-scroll', hasOlderMessages: start > 0, composer: null }}
      actions={{ onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {}, onStopCollaborationAgentRequest: () => {} }}
      presentation={{ pinActivities: withPins ? pinActivities : undefined }} selection={{}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Boundary />);
