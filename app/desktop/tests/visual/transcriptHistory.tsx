import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import '../../src/index.css';

type Row = { id: number; height: number; date: boolean };
function rows(start: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: start + index, height: 50, date: index === 0 }));
}
function History() {
  const [items, setItems] = useState(() => rows(100, 100));
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => setTimeout(() => setItems(current => [
      ...rows(current[0].id - 50, 50).map((row, index) => ({ ...row, height: index % 2 ? 90 : 45 })),
      ...current.map(row => ({ ...row, date: false })),
    ]), 100)}>Load older synthetic history</button>
    <button onClick={() => setItems(current => current.map(row => row.id === 99 ? { ...row, height: 190 } : row))}>Finish delayed media</button>
    <VirtualTranscript items={items} sessionKey="synthetic-history" getItemKey={row => row.id}
      estimateSize={row => row.height + (row.date ? 32 : 0)} scrollStyle={{ height: 600, overflowAnchor: 'none' }}
      renderItem={row => <div>
        {row.date ? <div data-transcript-time-separator style={{ height: 32 }}>Synthetic date</div> : null}
        <div data-message-id={row.id} style={{ height: row.height }}>Synthetic message {row.id}</div>
      </div>} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<History />);
