import { Profiler, useState, createRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { scheduleTranscriptScrollToBottom } from '../../src/pages/chatsPage.header';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { clearChatPerformanceRecords, readChatPerformanceRecords } from '../../src/features/performance/chatPerformance';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const count = Number(new URLSearchParams(location.search).get('count') ?? 2000);
const initial: Message[] = Array.from({ length: count }, (_, i) => ({
  id: `bench-${i}`, clientMessageId: `bench-${i}`, role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
  text: `Synthetic message ${i + 1}`, time: '12:00', timestampMs: 1770000000000 + i * 1000, statusChips: ['delivered'],
}));
const scrollRef = createRef<HTMLDivElement>();
const noop = () => {};
const actions = { onOpenSource: noop, onOpenArtifact: noop, onOpenAuthSettings: noop, onStopCollaborationAgentRequest: noop };
const selection = {};
const queuedMessages: never[] = [];
let commits: number[] = [];
const bench = { append: (_image = false, _text?: string) => {}, receipt: () => {}, type: () => {}, metrics: () => {
  const records = readChatPerformanceRecords();
  return {
    bubbles: records.filter(r => r.name === 'message-bubble-render').length,
    transcripts: records.filter(r => r.name === 'transcript-virtual-render').length,
    commitCount: commits.length,
    renderMs: commits.reduce((a, b) => a + b, 0),
    mountedRows: document.querySelectorAll('[data-transcript-window-item]').length,
  };
}, reset: () => { commits = []; clearChatPerformanceRecords(); } };
Object.assign(window, { sendRenderBench: bench });
globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [draft, setDraft] = useState('');
  useLayoutEffect(() => {
    bench.append = (image = false, text?: string) => {
      setDraft('');
      scheduleTranscriptScrollToBottom(scrollRef);
      setMessages(current => [
      ...current.map(message => ({ ...message })),
      { ...initial[0], id: `append-${current.length}`, clientMessageId: `append-${current.length}`, text: text ?? (image ? 'New image' : 'New message'),
        timestampMs: initial[0].timestampMs! + current.length * 1000, statusChips: ['sending'],
        attachments: image ? [{ kind: 'image', name: 'fixture.svg', widthPixels: 100, heightPixels: 100, previewUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="skyblue"/%3E%3C/svg%3E' }] : undefined },
    ]);
    };
    bench.receipt = () => setMessages(current => current.map((message, index) => index === current.length - 1 ? { ...message, id: `ack-${message.clientMessageId}`, statusChips: [message.statusChips?.[0] === 'delivered' ? 'read' : 'delivered'] } : { ...message }));
    bench.type = () => setDraft(current => `${current}a`);
  }, []);
  return <main className="kordi-app theme-dark" style={{ width: 850, height: 750, display: 'flex', flexDirection: 'column', padding: 20 }}>
    <Profiler id="chat" onRender={(_id, _phase, duration) => commits.push(duration)}>
      <ChatSessionPane viewport={{ sessionKey: 'render-bench', messages, queuedMessages, scrollRef, scrollClassName: 'min-h-0 flex-1', composer: <textarea aria-label="Message" rows={Math.min(6, draft.split('\n').length)} value={draft} onChange={e => setDraft(e.target.value)} /> }}
        presentation={{ liveTurnSender: 'Kordi', shouldRenderLiveTurn: false }} actions={actions} selection={selection} />
    </Profiler>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
