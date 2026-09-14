import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { applyCanonicalHydrationPlaceholder } from '../../src/app/viewModels/conversationSelection';
import { isTranscriptLoadingNotice } from '../../src/features/chat/transcriptLoadingNotice';
import type { SessionHydrationState } from '../../src/features/canonical/canonicalStore';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import '../../src/index.css';

type Row = { id: string; height: number };
const rows = (session: string): Row[] => Array.from({ length: 200 }, (_, index) => ({
  id: `${session}-${index}`, height: 36 + (index % 5) * 37,
}));
function Message({ row }: { row: Row }) {
  const [mediaReady, setMediaReady] = useState(false);
  const [lateMediaReady, setLateMediaReady] = useState(false);
  const [smallGrowth, setSmallGrowth] = useState(0);
  useLayoutEffect(() => {
    const grow = () => setSmallGrowth(value => value + 5);
    window.addEventListener('synthetic-small-growth', grow);
    return () => window.removeEventListener('synthetic-small-growth', grow);
  }, []);
  useLayoutEffect(() => {
    const loaded = () => setLateMediaReady(true);
    window.addEventListener('synthetic-media-loaded', loaded);
    return () => window.removeEventListener('synthetic-media-loaded', loaded);
  }, []);
  useLayoutEffect(() => {
    // Model a cached media preview receiving its dimensions after first paint.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setMediaReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const height = row.height + (mediaReady && row.id.endsWith('-199') ? 90 : 0)
    - (lateMediaReady && row.id.endsWith('-198') ? 90 : 0)
    + (row.id.endsWith('-198') ? smallGrowth : 0);
  if (new URLSearchParams(window.location.search).has('media') && row.id.endsWith('-198')) {
    return <div data-message-id={row.id}><MessageBubble msg={{
      role: 'person', sender: 'Synthetic sender', text: 'Synthetic image caption', time: '10:00',
      attachments: [{ kind: 'image', name: 'Synthetic portrait.svg', previewUrl: '/synthetic-portrait.svg' }],
    }} /></div>;
  }
  return <div data-message-id={row.id} style={{ height }}>Synthetic message {row.id}</div>;
}
function Entry() {
  const [session, setSession] = useState('first');
  const [items, setItems] = useState(() => rows('first'));
  const [hydration, setHydration] = useState<SessionHydrationState>('ready');
  const enter = (key: string, cold = false) => {
    setHydration('ready');
    setSession(key);
    setItems(cold ? [] : rows(key));
    if (cold) setTimeout(() => setItems(rows(key)), 100);
  };
  const selected = applyCanonicalHydrationPlaceholder({
    id: session, canonicalSessionId: session, canonicalMessageCount: 200,
    name: 'Synthetic chat', type: 'person', subtitle: 'Catalog preview', unread: 0,
    collaborationSources: ['Cloud'], trust: 'Cloud', directness: 'Person chat', participants: [],
    messages: items.map(row => ({ id: row.id, role: 'person', text: 'Synthetic message', time: '10:00' })),
  }, hydration);
  const loading = selected.messages.some(isTranscriptLoadingNotice);
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => enter('first')}>First session</button>
    <button onClick={() => enter('next')}>Next session</button>
    <button onClick={() => enter('cold', true)}>Cold session</button>
    <button onClick={() => { setSession('catalog'); setItems(rows('catalog').slice(-1)); setHydration('loading'); }}>Catalog-only session</button>
    <button onClick={() => { setItems(rows('catalog')); setHydration('ready'); }}>Finish catalog hydration</button>
    <button onClick={() => window.dispatchEvent(new Event('synthetic-media-loaded'))}>Finish late image</button>
    {loading ? <div data-transcript-initial-loading style={{ height: 600 }} /> : <VirtualTranscript items={items} sessionKey={session} getItemKey={row => row.id}
      animateTailResize={new URLSearchParams(window.location.search).has('progress')}
      estimateSize={() => 160} scrollStyle={{ height: 600, padding: '20px 20px 4px' }}
      emptyState={<div>Loading synthetic messages</div>}
      renderItem={row => <Message row={row} />} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Entry />);
