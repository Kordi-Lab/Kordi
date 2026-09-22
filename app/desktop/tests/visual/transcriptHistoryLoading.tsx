import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const SHORT_TEXTS = ['eq', 'wq', 'qw', 'e', 'qwdqw', 'wqd', 'dqwd', 'fwd', 'wdq', 'w', 'dqw', 'ok', 'yes', 'no'];
const PAGE = 40;

type Row = { message: Message; groupedWithPrevious: boolean; groupedWithNext: boolean };

function buildRows(startIndex: number, count: number): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const own = index % 7 < 3;
    const emoji = index % 53 === 0;
    const text = emoji ? '\u{1F600}' : SHORT_TEXTS[index % SHORT_TEXTS.length];
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
      },
      groupedWithPrevious: offset > 0 && previousOwn === own,
      groupedWithNext: offset < count - 1 && nextOwn === own,
    });
  }
  return rows;
}

// Mirrors the desktop history prefetch: scrolling near the top starts an older
// page that arrives after a short delay, while the reader keeps scrolling.
function HistoryLoading() {
  const [rows, setRows] = useState(() => buildRows(200, 240));
  const [hasOlder, setHasOlder] = useState(true);
  const loadingRef = useRef(false);
  const oldestRef = useRef(200);
  const loadOlder = useCallback(() => {
    if (loadingRef.current || !hasOlder) return Promise.resolve();
    loadingRef.current = true;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const start = oldestRef.current - PAGE;
        oldestRef.current = start;
        if (start <= 0) setHasOlder(false);
        setRows(current => [...buildRows(Math.max(0, start), Math.min(PAGE, start + PAGE)), ...current]);
        loadingRef.current = false;
        resolve();
      }, 60);
    });
  }, [hasOlder]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const onScroll = () => {
      if (element.scrollTop <= Math.max(320, element.clientHeight * 2)) void loadOlder();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [loadOlder]);
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <VirtualTranscript
      items={rows}
      sessionKey="synthetic-history-loading"
      scrollRef={scrollRef}
      getItemKey={row => row.message.id!}
      estimateSize={row => estimateTranscriptMessageHeight(row.message, false, { isGroupedWithPrevious: row.groupedWithPrevious, isGroupedWithNext: row.groupedWithNext })}
      scrollStyle={{ height: 600 }}
      hasOlder={hasOlder}
      onLoadOlder={loadOlder}
      renderItem={row => (
        <div data-message-id={row.message.id}>
          <MessageBubble msg={row.message} isGroupedWithPrevious={row.groupedWithPrevious} isGroupedWithNext={row.groupedWithNext} />
        </div>
      )}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<HistoryLoading />);
