import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installCopySurfaceSelectionTracking } from '../../src/features/contentSelection';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';

const messages: Message[] = [
  {
    id: 'selection-review-introduction', role: 'person', sender: 'System', senderType: 'human',
    time: '14:51', showSenderMeta: true,
    text: 'Welcome to the sample workshop. Try selecting just a few words, then drag across a line break.\n\n@Alex: exploring how teams organize research notes, compare early ideas, and build useful prototypes; can help with interview planning, qualitative analysis, and keeping project documentation clear.\n@Sam: building a shared project timeline and testing a new search interface; can help with interaction design, prototype feedback, and CSS layouts.\n@Taylor: studying conversation history and participant setup; can help with evaluation, data modeling, and writing clear summaries.',
    mentions: [{ label: 'Alex', targetKind: 'person' }, { label: 'Sam', targetKind: 'person' }, { label: 'Taylor', targetKind: 'person' }],
  },
  {
    id: 'selection-review-reply', role: 'user', sender: 'You', senderType: 'human', time: '14:52',
    text: 'I can select part of this sentence, including a range that wraps onto another line. The highlighted characters should match exactly what I copy.',
  },
  {
    id: 'selection-review-markdown', role: 'agent', sender: 'Assistant', time: '14:53',
    text: '### A formatted example\n\nSelect from **bold text** into regular text, or across these list items:\n\n- Review the first draft carefully.\n- Compare the results with the next draft.\n\nInline `sample code` is selectable too.',
  },
];

function TextSelectionPreview() {
  const [dark, setDark] = useState(false);
  useEffect(() => installCopySurfaceSelectionTracking(document), []);
  useEffect(() => {
    document.body.className = dark ? 'theme-dark' : 'theme-light';
    document.body.dataset.kordiChatTheme = 'quiet';
  }, [dark]);
  return (
    <main className={`kordi-app theme-${dark ? 'dark' : 'light'} flex h-dvh flex-col bg-[var(--utility-background)] text-[var(--utility-foreground)]`}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-current/10 px-6 py-4">
        <div>
          <h1 className="text-[15px] font-semibold">Text selection review</h1>
          <p className="mt-1 text-[13px] opacity-70">Drag to select a few characters or across lines. Double-click a word. Copy and paste below.</p>
        </div>
        <button className="app-button-quiet rounded-lg border border-current/20 px-3 py-1.5 text-[13px]" onClick={() => setDark(value => !value)}>
          {dark ? 'Light appearance' : 'Dark appearance'}
        </button>
      </header>
      <section className="app-chat-theme-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Sample conversation">
        <VirtualTranscript
          items={messages}
          sessionKey="text-selection-review"
          getItemKey={message => message.id!}
          scrollClassName="h-full overflow-y-auto px-7 py-8"
          gap={24}
          renderItem={message => <MessageBubble msg={message} />}
        />
      </section>
      <footer className="shrink-0 border-t border-current/10 px-6 py-4">
        <label htmlFor="selection-paste" className="mb-2 block text-[13px] font-medium">Paste here to check the exact text you copied</label>
        <textarea id="selection-paste" className="w-full resize-none rounded-lg border border-current/20 bg-transparent px-3 py-2 text-[13px]" rows={2} placeholder="Select text above, copy it, then paste here…" />
        <p className="mt-2 text-[11px] opacity-60">Local preview · Sample messages · Proposed fix</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<TextSelectionPreview />);
