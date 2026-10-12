import { createRoot } from 'react-dom/client';

import { installCopySurfaceSelectionTracking } from '../../src/features/contentSelection';

import { DocumentReader } from '../../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import { createDocumentShareApi } from '../../src/features/documents/documentShareApi';
import { createMemoryDocumentApi, SAMPLE_MARKDOWN, SAMPLE_TOKEN, sampleDocument } from '../helpers/documentReaderFixtures';
import '../../src/index.css';

// Login-free review page: ?state=local | uploaded | public, optional ?theme=dark.
// Live mode against the configured cloud API (local test stacks only): ?attachmentId=&token=&accountId=&name=.
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
const { api, calls } = createMemoryDocumentApi(state === 'public' ? sampleDocument('public') : ownerDocument, 400);
// The review page records what the mock server received (saves, comments, reactions) for end-to-end checks.
Object.assign(window, { __documentReaderCalls: calls });
// The app installs this at startup; the review page does too so selection behaves as in the app.
installCopySurfaceSelectionTracking(document);

function Panel({ shareOpen }: { shareOpen: boolean }) {
  if (state === 'local') {
    return <DocumentReader path="/Users/example/notes/related-work.md" localSource={SAMPLE_MARKDOWN} dateLabel="Oct 9, 2026" api={api} initialShareOpen={shareOpen} />;
  }
  if (state === 'public') {
    return <DocumentReader shareToken={SAMPLE_TOKEN} api={api} />;
  }
  return <DocumentReader path="/Users/example/notes/related-work.md" localSource={SAMPLE_MARKDOWN} attachmentId={ownerDocument.attachmentId} initialDocument={ownerDocument} api={api} initialShareOpen={shareOpen} />;
}

const live = params.get('attachmentId') && params.get('token') && params.get('accountId')
  ? { attachmentId: params.get('attachmentId')!, token: params.get('token')!, accountId: params.get('accountId')!, name: params.get('name') ?? 'Reviewer' }
  : null;

const liveApi = live
  ? createDocumentShareApi({ loadSession: async () => ({ token: live.token, accountId: live.accountId, expiresAt: '2099-01-01T00:00:00Z' }) })
  : null;

function LivePage({ session }: { session: NonNullable<typeof live> }) {
  const host: DocumentReaderHost = { ...owner, viewer: { accountId: session.accountId, displayName: session.name, kordiId: '', avatarUrl: null } };
  return (
    <DocumentReaderHostContext.Provider value={host}>
      <main className={`kordi-app ${theme}`} data-document-reader-fixture="live" style={{ display: 'flex', padding: 24, height: '100vh', boxSizing: 'border-box', background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
        <div style={{ display: 'flex', width: 640, minHeight: 0 }}><DocumentReader attachmentId={session.attachmentId} api={liveApi!} /></div>
      </main>
    </DocumentReaderHostContext.Provider>
  );
}

function Page() {
  if (live) return <LivePage session={live} />;
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
