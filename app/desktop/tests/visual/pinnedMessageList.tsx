import { createRoot } from 'react-dom/client';
import { PinnedMessageBar } from '../../src/pages/chatsPage.pins';
import type { PinnedMessageItem } from '../../src/pages/chatsPage.pinModel';
import '../../src/index.css';

const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.body.classList.add(`theme-${theme}`);
const now = Date.UTC(2026, 9, 16, 21, 1);
const items: PinnedMessageItem[] = [
  { scope: 'shared', message: { id: 'pin-1', role: 'user', sender: 'Me', text: '@babyshuShuYang do it again', time: '21:01', timestampMs: now } },
  { scope: 'shared', message: { id: 'pin-2', role: 'user', sender: 'Maya', text: 'Release checklist: review the copy, check mobile on a small phone, then share the build with the rest of the team before Friday.', time: '20:12', timestampMs: now - 49 * 60_000 } },
  { scope: 'private', message: { id: 'pin-3', role: 'user', sender: 'Alex', text: 'Preview link: design.kordi.example/chat', time: '18:40', timestampMs: now - 141 * 60_000 } },
];

function Fixture() {
  return (
    <main className={`kordi-app theme-${theme}`} style={{ minHeight: '100vh', background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
      <PinnedMessageBar items={items} onOpenMessage={() => undefined} onRequestUnpin={() => undefined} />
      <div data-fixture-transcript="true" style={{ padding: '24px 32px', fontSize: 16, lineHeight: '28px' }}>
        {Array.from({ length: 24 }, (_, index) => (
          <p key={index} style={{ margin: '0 0 8px' }}>
            This channel is <b>testing</b> the changes directly to <code style={{ padding: '2px 6px', borderRadius: 6, background: 'var(--app-control-bg)' }}>main</code>; I will use a separate test branch for the rest of the work.
          </p>
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
