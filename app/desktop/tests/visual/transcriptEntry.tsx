import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import '../../src/index.css';

type Row = { id: string; height: number };
const rows = (session: string): Row[] => Array.from({ length: 200 }, (_, index) => ({
  id: `${session}-${index}`, height: 36 + (index % 5) * 37,
}));
function Message({ row }: { row: Row }) {
  const [mediaReady, setMediaReady] = useState(false);
  useLayoutEffect(() => {
    // Model a cached media preview receiving its dimensions after first paint.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setMediaReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const height = row.height + (mediaReady && row.id.endsWith('-199') ? 90 : 0);
  return <div data-message-id={row.id} style={{ height }}>Synthetic message {row.id}</div>;
}
function Entry() {
  const [session, setSession] = useState('first');
  const [items, setItems] = useState(() => rows('first'));
  const enter = (key: string, cold = false) => {
    setSession(key);
    setItems(cold ? [] : rows(key));
    if (cold) setTimeout(() => setItems(rows(key)), 100);
  };
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => enter('first')}>First session</button>
    <button onClick={() => enter('next')}>Next session</button>
    <button onClick={() => enter('cold', true)}>Cold session</button>
    <VirtualTranscript items={items} sessionKey={session} getItemKey={row => row.id}
      estimateSize={() => 160} scrollStyle={{ height: 600, overflowAnchor: 'none' }}
      emptyState={<div>Loading synthetic messages</div>}
      renderItem={row => <Message row={row} />} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Entry />);
