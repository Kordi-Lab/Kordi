import { createRef, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { createTranscriptReferenceStabilizer } from '../../src/features/chat/transcriptReferenceStability';
import type { Conversation, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const names = ['First message', 'Second message', 'Third message', 'Fourth message'];
const pending: Message[] = names.map((text, index) => ({
  id: `local-${index}`, clientMessageId: `local-${index}`, role: 'user', isOwnMessage: true,
  senderType: 'human', text, time: '11:30', timestampMs: 1000 + index * 100, statusChips: ['sending'],
}));
const noop = () => {};
const actions = { onOpenSource: noop, onRequestCollaborationContact: noop, onStopCollaborationAgentRequest: noop };
const scrollRef = createRef<HTMLDivElement>();

function Fixture() {
  const [messages, setMessages] = useState(pending);
  const [acknowledged, setAcknowledged] = useState(0);
  const [stabilizer] = useState(createTranscriptReferenceStabilizer);
  const conversation: Conversation = { id: 'chat', canonicalSessionId: 'chat', name: 'Chat', type: 'person',
    subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: 'Contact', directness: 'Direct',
    participants: ['Me', 'Peer'], messages };
  const prepared = stabilizer.prepare([conversation]);
  useLayoutEffect(() => stabilizer.commit(prepared), [prepared, stabilizer]);
  const acknowledge = () => {
    const index = acknowledged;
    setAcknowledged(index + 1);
    setMessages((rows) => rows.map((row) => row.clientMessageId === `local-${index}`
      ? { ...row, id: `server-${index}`, timestampMs: 2000 + index * 500, conversationSequence: index + 1,
          statusChips: ['delivered'] } : row).sort((left, right) => left.timestampMs! - right.timestampMs!));
  };
  return <main className="kordi-app theme-light" style={{ width: 700, height: 600, display: 'flex', flexDirection: 'column' }}>
    <button onClick={acknowledge} disabled={acknowledged === pending.length}>Acknowledge next message</button>
    <ChatSessionPane viewport={{ sessionKey: 'chat', messages: prepared.conversations[0].messages, scrollRef,
      scrollClassName: 'min-h-0 flex-1', composer: <textarea aria-label="Message" /> }}
      presentation={{ liveTurnSender: 'Kordi', shouldRenderLiveTurn: false }} actions={actions} selection={{}} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
