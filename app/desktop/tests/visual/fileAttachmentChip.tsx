import { createRoot } from 'react-dom/client';

import { AttachmentPreview } from '../../src/kordi-app/components/transcriptAttachments';
import type { Message, MessageAttachment } from '../../src/kordi-app/types';
import '../../src/index.css';

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'theme-dark' : 'theme-light';
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';

function file(
  name: string,
  sizeBytes: number,
  mimeType: string,
): MessageAttachment {
  return {
    attachmentId: `att-${name}`,
    kind: 'file',
    name,
    mimeType,
    sizeBytes,
  };
}

function message(overrides: Partial<Message> & Pick<Message, 'role' | 'text'>): Message {
  return {
    time: '22:32',
    ...overrides,
  };
}

const ownMessage = message({
  role: 'user',
  isOwnMessage: true,
  text: 'check this',
  attachments: [file('2027ICLR_v6 copy.pdf', 2_500_000, 'application/pdf')],
});

const ownMulti = message({
  role: 'user',
  isOwnMessage: true,
  text: 'everything for the submission',
  attachments: [
    file('ablation-results.csv', 88_000, 'text/csv'),
    file('train_loop.py', 12_000, 'text/x-python'),
    file('architecture-diagram.png', 1_150_000, 'image/png'),
    file('figures-and-appendix.zip', 19_000_000, 'application/zip'),
  ],
});

const ownNoText = message({
  role: 'user',
  isOwnMessage: true,
  text: '',
  attachments: [file('submission.docx', 640_000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')],
});

const ownLongName = message({
  role: 'user',
  isOwnMessage: true,
  text: 'long name',
  attachments: [file(
    '2027-iclr-submission-camera-ready-final-v6-with-appendix-and-supplementary-materials.pdf',
    12_800_000,
    'application/pdf',
  )],
});

const peerMessage = message({
  role: 'person',
  text: 'here is the deck',
  attachments: [file('review-deck.pptx', 4_200_000, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')],
});

const agentSending = message({
  role: 'owned-agent',
  sender: 'My Kordi',
  text: 'exporting the design now',
  statusChips: ['sending'],
  attachments: [file('redesign-v3.fig', 8_400_000, 'application/octet-stream')],
});

function Bubble({ variant, msg }: { variant: 'own' | 'peer' | 'agent'; msg: Message }) {
  const own = variant === 'own';
  return (
    <div style={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start' }}>
      <div
        className={`app-chat-bubble-${variant}`}
        style={{
          position: 'relative',
          maxWidth: 380,
          borderRadius: 14,
          borderBottomRightRadius: own ? 5 : 14,
          borderBottomLeftRadius: own ? 14 : 5,
          background: 'var(--app-message-bubble-fill)',
          color: 'var(--app-chat-bubble-' + (own ? 'user' : variant) + '-text)',
          padding: '9px 12px 7px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <AttachmentPreview msg={msg} />
          {msg.text ? <p style={{ margin: 0, fontSize: 13, lineHeight: 1.4 }}>{msg.text}</p> : null}
        </div>
        <Meta variant={variant} />
      </div>
    </div>
  );
}

function Meta({ variant }: { variant: 'own' | 'peer' | 'agent' }) {
  if (variant !== 'own') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, marginTop: 4, color: 'var(--app-chat-meta-own)', fontSize: 10 }}>
      22:32
      <svg width="14" height="10" viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#15803d' }}>
        <path d="M1 6.5 4.5 10 11 1" />
        <path d="M8 6.5 11.5 10 18 1" />
      </svg>
    </div>
  );
}

function Fixture() {
  return (
    <main
      className={`kordi-app ${theme}`}
      data-file-attachment-chip-fixture="true"
      style={{ minHeight: '100vh', padding: 28, background: 'var(--app-page-bg)' }}
    >
      <div
        className="app-chat-theme-surface"
        style={{
          width: 620,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderRadius: 18,
          padding: '22px 20px',
          border: '1px solid var(--app-shell-border)',
        }}
      >
        <Bubble variant="own" msg={ownMessage} />
        <Bubble variant="peer" msg={peerMessage} />
        <Bubble variant="agent" msg={agentSending} />
        <Bubble variant="own" msg={ownMulti} />
        <Bubble variant="own" msg={ownLongName} />
        <Bubble variant="own" msg={ownNoText} />
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
