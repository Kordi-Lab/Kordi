import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import '../../src/index.css';

// Mirrors a busy group chat: runs of short messages from the same sender
// (grouped rows, only the first shows the sender line) plus standalone emoji.
// These shapes are what a real long history scrolls through.
const SHORT_TEXTS = ['eq', 'wq', 'qw', 'e', 'qwdqw', 'wqd', 'dqwd', 'fwd', 'wdq', 'w', 'dqw', 'ok', 'yes', 'no'];
const mixed = new URLSearchParams(window.location.search).has('mixed');
const media = new URLSearchParams(window.location.search).has('media');

type Row = { message: Message; groupedWithPrevious: boolean; groupedWithNext: boolean };

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < 300; index += 1) {
    const own = index % 7 < 3;
    const emoji = index % 53 === 0;
    const text = mixed && index % 3 === 0
      ? `### Synthetic history ${index}\n\n${'A longer message wraps across the narrow chat bubble. '.repeat(12)}\n\n- First detail\n- Second detail\n\n\`\`\`text\n${'A code sample\n'.repeat(6)}\`\`\``
      : emoji ? '\u{1F600}' : SHORT_TEXTS[index % SHORT_TEXTS.length];
    const previousOwn = (index - 1) % 7 < 3;
    const nextOwn = (index + 1) % 7 < 3;
    rows.push({
      message: {
        id: `row-${index}`,
        role: own ? 'user' : 'person',
        sender: own ? 'You' : 'Person',
        isOwnMessage: own,
        showSenderMeta: !own,
        text,
        time: '10:00',
        ...(media && index % 9 === 0 ? { attachments: [{ kind: 'image' as const,
          name: `Synthetic image ${index}`, previewUrl: `/synthetic-history/image-${index}.svg`,
          widthPixels: 480, heightPixels: 640 }] } : {}),
        ...(media && index % 2 === 0 ? { sourceMessage: {
          messageId: `quoted-${index}`, senderLabel: 'Synthetic peer',
          text: 'A quoted message with enough words to exercise the reference line.',
        } } : {}),
      },
      groupedWithPrevious: index > 0 && previousOwn === own,
      groupedWithNext: index < 299 && nextOwn === own,
    });
  }
  return rows;
}

function Stability() {
  const [items] = useState(buildRows);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (new URLSearchParams(window.location.search).has('pane')) {
    return <main className="app-chat-split-workspace" style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
      <ChatSessionPane viewport={{ sessionKey: 'synthetic-history-pane', messages: items.map(row => row.message),
        scrollRef, scrollClassName: 'app-chat-pane-transcript-scroll', composer: null }}
        actions={{ onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {}, onStopCollaborationAgentRequest: () => {} }}
        presentation={{}} selection={{}} />
    </main>;
  }
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <VirtualTranscript
      items={items}
      sessionKey="synthetic-history-stability"
      getItemKey={row => row.message.id!}
      estimateSize={row => estimateTranscriptMessageHeight(row.message, false, { isGroupedWithPrevious: row.groupedWithPrevious, isGroupedWithNext: row.groupedWithNext })}
      scrollStyle={{ height: 600 }}
      renderItem={row => (
        <div data-message-id={row.message.id}>
          <MessageBubble
            msg={row.message}
            isGroupedWithPrevious={row.groupedWithPrevious}
            isGroupedWithNext={row.groupedWithNext}
          />
        </div>
      )}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Stability />);
