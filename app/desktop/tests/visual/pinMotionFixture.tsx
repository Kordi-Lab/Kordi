import { useState } from 'react';
import { PinnedMessageShelf } from '../../src/pages/PinnedMessageShelf';
import { PinActivityNotice } from '../../src/pages/chatsPage.pins';
import type { Message } from '../../src/kordi-app/types';

const message: Message = { id: 'synthetic-pin', role: 'user', sender: 'Me', text: 'Synthetic pinned message', time: '12:00' };
export function PinMotionFixture() {
  const [pinned, setPinned] = useState(new URLSearchParams(location.search).has('pinned'));
  const [notice, setNotice] = useState(0);
  return <main className="kordi-app theme-light" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ height: 60 }}>Synthetic conversation</header>
    <PinnedMessageShelf items={pinned ? [{ message, scope: 'shared' }] : []} onOpenMessage={() => {}} onRequestUnpin={() => setPinned(false)} />
    <section style={{ flex: 1 }}>Existing conversation history</section>
    {notice > 0 && <PinActivityNotice activity={{ id: `synthetic-notice-${notice}`, label: 'You pinned a message', timestampMs: 1_789_472_400_000, animate: true }} />}
    <footer>
      <button onClick={() => { setPinned(value => !value); setNotice(value => value + 1); }}>Toggle pin</button>
    </footer>
  </main>;
}
