import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageLayoutSetting } from '../../src/kordi-app/components/MessageLayoutSetting';
import { setMessageLayout } from '../../src/app/messageLayoutPreference';
import { useChatTranscriptViewport } from '../../src/pages/chatsPage.transcriptViewport';
import { navigateToTranscriptMessage } from '../../src/features/chat/transcriptNavigation';
import type { VirtualTranscriptNavigationRequest } from '../../src/features/chat/useVirtualTranscriptNavigation';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
setMessageLayout(params.get('layout') === 'chat' ? 'chat' : 'threads');
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
const messages: Message[] = [
  { id: 'date-first', role: 'person', senderType: 'human', sender: 'Maya Chen', text: 'The rollout notes are ready.', time: 'Oct 2 09:00', timestampMs: Date.parse('2026-10-02T09:00:00Z') },
  { id: 'date-evening', role: 'person', senderType: 'human', sender: 'Maya Chen', text: 'I added the final device checks to the notes.', time: 'Oct 2 18:00', timestampMs: Date.parse('2026-10-02T18:00:00Z') },
  { id: 'date-next', role: 'person', senderType: 'human', sender: 'Alex Rivera', text: 'Can you send the latest numbers?', time: 'Oct 3 00:01', timestampMs: Date.parse('2026-10-03T00:01:00Z') },
  { id: 'date-quote', role: 'user', senderType: 'human', isOwnMessage: true, sender: 'You', text: 'The updated report is ready for review.', time: 'Oct 3 00:02', timestampMs: Date.parse('2026-10-03T00:02:00Z'),
    sourceMessage: { messageId: 'date-first', senderLabel: 'Maya Chen', text: 'The rollout notes are ready.' } },
];
const entries = messages.map((message, originalIndex) => ({ message, originalIndex }));
function Preview() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [action, setAction] = useState('');
  const [navigationRequest, setNavigationRequest] = useState<VirtualTranscriptNavigationRequest | null>(null);
  const transcript = useChatTranscriptViewport({
    viewport: { sessionKey: 'thread-date-preview', messages, scrollRef, scrollClassName: 'flex-1 min-h-0', navigationRequest, onNavigationHandled: () => setNavigationRequest(null) },
    presentation: { densityMode: 'contact-compact' }, selection: {},
    actions: {
      onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {}, onStopCollaborationAgentRequest: () => {},
      onNavigateToMessage: id => { setAction(`navigate:${id}`); navigateToTranscriptMessage(id, scrollRef); },
      onReplyMessage: message => setAction(`quote:${message.id}`), onOpenMessageThread: message => setAction(`discussion:${message.id}`),
    },
    transcriptEntries: entries, transcriptMessages: messages, transcriptTailKey: 'date-quote',
  });
  return <main style={{ maxWidth: 1120, margin: '0 auto', padding: 20, height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <MessageLayoutSetting />
    <output data-last-action={action}>{action}</output>
    <button onClick={() => setNavigationRequest({ id: 'date-first', nonce: Date.now(), sessionKey: 'thread-date-preview' })}>Jump to first message</button>
    {transcript}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
