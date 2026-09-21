import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Mirrors a busy group chat: runs of short messages from the same sender
// (grouped rows, only the first shows the sender line) plus standalone emoji.
const SHORT_TEXTS = ['eq', 'wq', 'qw', 'e', 'qwdqw', 'wqd', 'dqwd', 'fwd', 'wdq', 'w', 'dqw', 'ok', 'yes', 'no'];

type Row = { message: Message; groupedWithPrevious: boolean; groupedWithNext: boolean };

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < 300; index += 1) {
    const own = index % 7 < 3;
    const emoji = index % 53 === 0;
    const text = emoji ? '\u{1F600}' : SHORT_TEXTS[index % SHORT_TEXTS.length];
    const previousOwn = (index - 1) % 7 < 3;
    const nextOwn = (index + 1) % 7 < 3;
    const sameAsPrevious = index > 0 && previousOwn === own;
    const sameAsNext = index < 299 && nextOwn === own;
    rows.push({
      message: {
        id: `row-${index}`,
        role: own ? 'user' : 'person',
        sender: own ? 'You' : 'Person',
        isOwnMessage: own,
        showSenderMeta: !own,
        text,
        time: '10:00',
      },
      groupedWithPrevious: sameAsPrevious,
      groupedWithNext: sameAsNext,
    });
  }
  return rows;
}

function ShapeProbe() {
  const [items] = useState(buildRows);
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <VirtualTranscript
      items={items}
      sessionKey="synthetic-shapes"
      getItemKey={row => row.message.id!}
      estimateSize={row => estimateTranscriptMessageHeight(row.message, false, { isGroupedWithPrevious: row.groupedWithPrevious, isGroupedWithNext: row.groupedWithNext })}
      scrollStyle={{ height: 600 }}
      renderItem={row => (
        <div data-message-id={row.message.id} data-estimate={estimateTranscriptMessageHeight(row.message, false, { isGroupedWithPrevious: row.groupedWithPrevious, isGroupedWithNext: row.groupedWithNext })}>
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
createRoot(document.getElementById('root')!).render(<ShapeProbe />);
