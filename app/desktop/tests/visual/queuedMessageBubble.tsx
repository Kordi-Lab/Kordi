import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import { QueuedMessageBubble } from '../../src/pages/chatsPage.queuedMessage';
import '../../src/index.css';

type QueuedPreviewMessage = { id: string; sessionId: string; text: string; time: string; attachments: unknown[] };

const sent: Message = {
  id: 'sent', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
  text: 'Can you check why the nightly build failed?', time: '08:39', statusChips: ['read'],
};
const initialQueue: QueuedPreviewMessage[] = [
  { id: 'queued-short', sessionId: 'preview', text: 'Also look at the flaky login test', time: '08:40', attachments: [] },
  { id: 'queued-long', sessionId: 'preview', text: 'Then open a draft PR with the fix\nand tag the release owner', time: '08:41', attachments: [] },
];
const params = new URLSearchParams(window.location.search);
const only = params.get('theme');
const themes = only === 'light' || only === 'dark' ? [only] : ['light', 'dark'];

function Transcript({ theme, compact = false }: { theme: string; compact?: boolean }) {
  const [queue, setQueue] = useState(initialQueue);
  const [edited, setEdited] = useState<string | null>(null);
  const [activated, setActivated] = useState<QueuedPreviewMessage[]>([]);
  return (
    <section
      className={`kordi-app theme-${theme} app-chat-theme-surface`}
      data-preview-theme={theme}
      data-preview-density={compact ? 'compact' : 'default'}
      style={{ display: 'block', flex: 1, minWidth: 0, minHeight: '100vh', padding: '32px 24px', color: 'var(--utility-foreground)' }}
    >
      <MessageBubble msg={sent} densityMode={compact ? 'contact-compact' : 'default'} isGroupedWithNext={compact} />
      {queue.map((message, index) => (
        <QueuedMessageBubble
          key={message.id}
          message={message}
          isCompressionActive={false}
          densityMode={compact ? 'contact-compact' : 'default'}
          showAvatar={index === queue.length - 1}
          onEdit={(_sessionId, id) => setEdited(id)}
          onCancel={(_sessionId, id) => setQueue((current) => current.filter((item) => item.id !== id))}
        />
      ))}
      {activated.map((message, index) => (
        <div key={message.id}>
          <div className="app-transcript-activate-enter">
            <MessageBubble
              msg={{ id: message.id, role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true, text: message.text, time: message.time, statusChips: ['read'] }}
              densityMode={compact ? 'contact-compact' : 'default'}
            />
          </div>
          {index === activated.length - 1 ? (
            <div className="app-transcript-activate-enter" style={{ padding: '8px 0 0 40px', fontSize: 13, opacity: 0.7 }}>Working</div>
          ) : null}
        </div>
      ))}
      {params.has('activate') && queue.length > 0 ? (
        <button
          type="button"
          data-preview-activate="true"
          style={{ marginTop: 16, fontSize: 12 }}
          onClick={() => {
            const next = queue[queue.length - 1];
            setQueue((current) => current.filter((item) => item.id !== next.id));
            setActivated((current) => [...current, next]);
          }}
        >
          Activate last queued message
        </button>
      ) : null}
      {edited ? <p data-preview-edited={edited} style={{ marginTop: 16, fontSize: 12, opacity: 0.6 }}>Editing {edited}</p> : null}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'flex', flexWrap: 'wrap', minHeight: '100vh' }}>
    {themes.map((theme) => <Transcript key={theme} theme={theme} />)}
    {themes.map((theme) => <Transcript key={`${theme}-compact`} theme={theme} compact />)}
  </main>,
);
