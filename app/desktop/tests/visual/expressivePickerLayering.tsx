import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { ComposerDropSurface } from '../../src/pages/chatsPage.composerDropSurface';
import { ComposerExpressivePicker } from '../../src/features/emoji/ComposerExpressivePicker';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Synthetic component regression fixture, not a product demo.
const sampleImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="orange"/></svg>')}`;
Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
  convertFileSrc: () => sampleImage,
  invoke: async (command: string) => {
    if (command === 'desktop_fetch_remote_image_data_url') {
      return sampleImage;
    }
    throw new Error(`Unsupported offline fixture command: ${command}`);
  },
}, configurable: true });
localStorage.setItem('kordi.expressiveMediaLibrary.v1', JSON.stringify(
  ['sticker', 'gif'].map(kind => ({ id: kind, kind, name: `Sample ${kind}`,
    path: `sample.${kind === 'gif' ? 'gif' : 'png'}`, mimeType: kind === 'gif' ? 'image/gif' : 'image/png',
    sizeBytes: 100, createdAtMs: 1 })),
));
const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
  id: `emoji-${index}`, role: 'person', sender: 'Sample person', senderType: 'human',
  text: '😀', time: '12:00',
}));
function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState('');
  return <main className={`kordi-app theme-${new URLSearchParams(location.search).get('theme') ?? 'light'}`}
    style={{ width: 680, height: 800, display: 'flex', flexDirection: 'column', padding: 24 }}>
    <p>Offline picker layering regression</p><output data-testid="selection">{selected}</output>
    <ChatSessionPane presentation={{ liveTurnSender: '', shouldRenderLiveTurn: false }} selection={{}}
      actions={{ onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {}, onStopCollaborationAgentRequest: () => {} }}
      viewport={{ sessionKey: 'picker-layering', messages, scrollRef,
        scrollClassName: 'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden',
        composer: <div className="app-chat-composer-frame shrink-0 pt-3">
          <ComposerDropSurface saveDesktopAttachments={async () => []}>
            <textarea aria-label="Message" />
            <ComposerExpressivePicker captureSelection={() => ({ start: 0, end: 0 })}
              onSelectText={setSelected} onSendMedia={attachment => setSelected(attachment.name)} />
          </ComposerDropSurface>
        </div>,
      }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
