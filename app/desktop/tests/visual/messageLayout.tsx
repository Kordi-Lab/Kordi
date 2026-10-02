import { setMessageLayout } from '../../src/app/messageLayoutPreference';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { navigateToTranscriptMessage } from '../../src/features/chat/transcriptNavigation';
import { LiveChatTurnMessage } from '../../src/kordi-app/components/transcriptLiveTurns';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { MessageLayoutSetting } from '../../src/kordi-app/components/MessageLayoutSetting';
import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Production components with offline sample messages and observable action handlers.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
if (params.get('layout') === 'threads') setMessageLayout('threads');
if (params.get('layout') === 'chat') setMessageLayout('chat');
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
const messages: Message[] = [
  { id: 'layout-source', role: 'person', senderType: 'human', sender: 'Maya Chen', text: "What’s the cleanest way to keep replies easy to follow?", time: '09:38', showSenderMeta: true,
    replySummary: { replyCount: 1, pending: false, targetMessageId: 'layout-quote' }, threadSummary: { replyCount: 6, unread: true },
    reactions: [{ value: '👍', accountIds: ['sample-person'] }] },
  { id: 'layout-quote', role: 'user', senderType: 'human', sender: 'You', isOwnMessage: true, text: 'Keep the quoted message above the reply. The conversation stays in one place.', time: '09:39', statusChips: ['delivered'], reactionConversationId: 'sample', reactionTargetMessageId: 'layout-quote', cloudMessageVersion: 1,
    sourceMessage: { messageId: 'layout-source', senderLabel: 'Maya Chen', text: messagesSourceText() },
    messageAction: { schemaVersion: 1, kind: 'quote', source: { sourceSessionId: 'sample', sourceMessageId: 'layout-source', senderLabel: 'Maya Chen', textPreview: messagesSourceText(), attachmentCount: 0 } } },
  { id: 'layout-code', role: 'person', senderType: 'human', sender: 'Alex Rivera', text: 'Formatting still works: **bold**, mentions, and code.\n\n```swift\nlet layout = MessageLayout.threads\n```', time: '09:41', showSenderMeta: true },
  { id: 'layout-agent', role: 'owned-agent', senderType: 'agent', sender: 'Research assistant', text: 'The same actions remain available in both layouts.\n\n- Quote in the conversation\n- Open a separate discussion\n- Forward, pin, edit, or select a message', time: '09:42' },
  { id: 'layout-live-quote', role: 'owned-agent', senderType: 'agent', sender: 'Research assistant', text: '', time: '09:42', turn: {
    id: 'layout-live-quote', sessionId: 'sample', prompt: '', status: 'done', message: '', assistantText: 'Completed agent replies use the same quoted reference.', thinkingText: '', tools: [], completed: true, succeeded: true,
    sourceMessage: { messageId: 'layout-source', senderLabel: 'Maya Chen', text: messagesSourceText() },
  } },
  { id: 'layout-file', role: 'person', senderType: 'human', sender: 'Maya Chen', text: 'Here is the implementation note.', time: '09:43', attachments: [{ kind: 'file', name: 'layout-notes.md', sizeBytes: 2048, downloadUrl: '/tests/visual/message-layout-notes.md' }] },
  { id: 'layout-failed', role: 'user', senderType: 'human', sender: 'You', isOwnMessage: true, text: 'A message waiting to be retried.', time: '09:44', statusChips: ['failed'] },
];
function messagesSourceText() { return "What’s the cleanest way to keep replies easy to follow?"; }
const liveTurn: DesktopChatTurnSnapshot = { id: 'layout-streaming', sessionId: 'sample', prompt: '', status: 'running', message: '', assistantText: 'Checking the layout…', thinkingText: '', tools: [], completed: false, succeeded: false,
  sourceMessage: { messageId: 'layout-source', senderLabel: 'Maya Chen', text: messagesSourceText() } };
function Preview() {
  const [action, setAction] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return <main style={{ maxWidth: 1120, margin: '0 auto', padding: '20px', height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ marginBottom: 12 }}><h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--utility-foreground)' }}>Kordi · Message layout</h1><p style={{ color: 'var(--utility-muted-text)' }}>Implementation preview · Offline sample conversation</p></header>
    <MessageLayoutSetting />
    <output data-last-action={action} style={{ minHeight: 26, color: 'var(--utility-muted-text)' }}>{action}</output>
    {selectionMode ? <button onClick={() => setSelectionMode(false)}>Cancel selection</button> : null}
    <VirtualTranscript tail={<LiveChatTurnMessage turn={liveTurn} sender="Research assistant" onStopActiveTurn={() => setAction('stop:layout-streaming')}
      onNavigateToMessage={id => { setAction(`navigate:${id}`); navigateToTranscriptMessage(id, scrollRef); }} />} tailKey="layout-streaming"
      items={messages} sessionKey="layout-preview" getItemKey={message => message.id!} estimateSize={() => 120}
      scrollRef={scrollRef} scrollStyle={{ flex: 1, minHeight: 0, padding: '8px 4px' }}
      renderItem={message => <MessageBubble msg={message}
        onNavigateToMessage={id => { setAction(`navigate:${id}`); navigateToTranscriptMessage(id, scrollRef); }}
        onReplyMessage={msg => setAction(`quote:${msg.id}`)} onOpenMessageThread={msg => setAction(`discussion:${msg.id}`)}
        onForwardMessage={msg => setAction(`forward:${msg.id}`)} onEditMessage={msg => setAction(`edit:${msg.id}`)}
        onDeleteMessage={msg => setAction(`delete:${msg.id}`)} onRetryMessage={msg => setAction(`retry:${msg.id}`)}
        onOpenMessageDetail={msg => setAction(`detail:${msg.id}`)} onRequestPinMessage={msg => setAction(`pin:${msg.id}`)}
        onSelectMessage={msg => { setSelectionMode(true); setSelected([msg.id!]); setAction(`select:${msg.id}`); }}
        selectionMode={selectionMode} selectedMessageIds={new Set(selected)} isMessageSelectable={() => true}
        onToggleSelectedMessage={msg => setSelected(selected.includes(msg.id!) ? selected.filter(id => id !== msg.id) : [...selected, msg.id!])}
        onReactMessage={(msg, reaction) => setAction(`react:${msg.id}:${reaction}`)} />}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
