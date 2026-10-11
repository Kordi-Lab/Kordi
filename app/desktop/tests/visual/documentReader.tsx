import { createRoot } from 'react-dom/client';

import { DocumentReader } from '../../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import { createMemoryDocumentApi, SAMPLE_MARKDOWN, SAMPLE_TOKEN, sampleDocument } from '../helpers/documentReaderFixtures';
import '../../src/index.css';

// Login-free review page: ?state=local | uploaded | public, optional ?theme=dark.
const params = new URLSearchParams(location.search);
const state = params.get('state') === 'local' ? 'local' : params.get('state') === 'public' ? 'public' : 'uploaded';
const theme = params.get('theme') === 'light' ? 'theme-light' : 'theme-dark';
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';
document.body.style.margin = '0';

const owner: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: ['Priya', 'Theo'],
  canMessageAccount: () => true,
  messageAccount: () => undefined,
  sendAttachment: () => undefined,
  revealPath: () => undefined,
};

const reader: DocumentReaderHost = {
  ...owner,
  viewer: { accountId: 'acct_example_theo', displayName: 'Theo', kordiId: '555123456', avatarUrl: null },
};

const ownerDocument = sampleDocument('owner');
const { api } = createMemoryDocumentApi(state === 'public' ? sampleDocument('public') : ownerDocument, 400);

function Panel({ shareOpen }: { shareOpen: boolean }) {
  if (state === 'local') {
    return <DocumentReader path="/Users/example/notes/related-work.md" localSource={SAMPLE_MARKDOWN} dateLabel="Oct 9, 2026" api={api} initialShareOpen={shareOpen} />;
  }
  if (state === 'public') {
    return <DocumentReader shareToken={SAMPLE_TOKEN} api={api} />;
  }
  return <DocumentReader path="/Users/example/notes/related-work.md" localSource={SAMPLE_MARKDOWN} attachmentId={ownerDocument.attachmentId} initialDocument={ownerDocument} api={api} initialShareOpen={shareOpen} />;
}

function Page() {
  return (
    <DocumentReaderHostContext.Provider value={state === 'public' ? reader : owner}>
      <main className={`kordi-app ${theme}`} data-document-reader-fixture={state} style={{ display: 'flex', gap: 24, padding: 24, height: '100vh', boxSizing: 'border-box', background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
        <div style={{ display: 'flex', width: 420, minHeight: 0 }}><Panel shareOpen={false} /></div>
        {state === 'public' ? null : <div style={{ display: 'flex', width: 420, minHeight: 0 }}><Panel shareOpen /></div>}
      </main>
    </DocumentReaderHostContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
