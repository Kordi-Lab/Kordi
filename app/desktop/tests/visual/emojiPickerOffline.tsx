import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmojiPicker } from '../../src/features/emoji/EmojiPicker';
import { preloadNotoEmojiThumbnails } from '../../src/features/emoji/notoEmojiThumbnails';
import '../../src/index.css';

// Exercise the native branch with no network or native image loader available.
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: { invoke: async (_command: string, args: { url: string }) => {
    if (args.url.includes('fonts.gstatic.com')) {
      document.documentElement.dataset.notoRequests = String(Number(document.documentElement.dataset.notoRequests ?? 0) + 1);
    }
    throw new Error('Offline image fixture');
  } }, configurable: true,
});
void preloadNotoEmojiThumbnails().then(() => { document.documentElement.dataset.emojiSheets = 'ready'; });

function Fixture() {
  const [open, setOpen] = useState(false);
  return <main className="kordi-app theme-dark" style={{ padding: 24, display: 'block', minHeight: '100vh' }}>
    <button type="button" onClick={() => setOpen(value => !value)}>{open ? 'Close picker' : 'Open picker'}</button>
    {open ? <section data-testid="picker" className="app-transient-surface" style={{ width: 420, height: 440, marginTop: 12 }}>
      <EmojiPicker onSelect={() => {}} />
    </section> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
