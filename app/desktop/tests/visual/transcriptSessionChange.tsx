import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const SHORT_TEXTS = ['eq', 'wq', 'qw', 'e', 'qwdqw', 'wqd', 'dqwd', 'fwd', 'wdq', 'w', 'dqw', 'ok', 'yes', 'no'];

type Row = { message: Message; groupedWithPrevious: boolean; groupedWithNext: boolean };

function buildRows(startIndex: number, count: number, session: string): Row[] {
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
        id: `${session}-${index}`,
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

function renderRow(row: Row) {
  return (
    <div data-message-id={row.message.id}>
      <MessageBubble msg={row.message} isGroupedWithPrevious={row.groupedWithPrevious} isGroupedWithNext={row.groupedWithNext} />
    </div>
  );
}

function estimate(row: Row) {
  return estimateTranscriptMessageHeight(row.message, false, {
    isGroupedWithPrevious: row.groupedWithPrevious,
    isGroupedWithNext: row.groupedWithNext,
  });
}

function SessionChange() {
  const [session, setSession] = useState('a');
  const [rows, setRows] = useState(() => buildRows(100, 120, 'a'));
  const [cold, setCold] = useState(false);
  const enter = (key: string) => {
    setSession(key);
    setCold(false);
    setRows(buildRows(100, 120, key));
  };
  const enterCold = (key: string) => {
    setSession(key);
    setCold(true);
    setRows([]);
    setTimeout(() => { setRows(buildRows(100, 120, key)); setCold(false); }, 120);
  };
  const prepend = () => setRows(current => [
    ...buildRows(100 - 60, 60, session),
    ...current,
  ]);
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', gap: 4, padding: 4 }}>
      <button onClick={() => enter('a')}>Session A</button>
      <button onClick={() => enter('b')}>Session B</button>
      <button onClick={() => enterCold('c')}>Cold session C</button>
      <button onClick={prepend}>Load older</button>
    </div>
    <VirtualTranscript
      items={rows}
      sessionKey={session}
      getItemKey={row => row.message.id!}
      estimateSize={estimate}
      scrollStyle={{ height: 600 }}
      emptyState={<div>Loading synthetic messages</div>}
      renderItem={renderRow}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionChange />);
