import { createRoot } from 'react-dom/client';

import { installCopySurfaceSelectionTracking } from '../../src/features/contentSelection';

import { DocumentReader } from '../../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import { createDocumentShareApi } from '../../src/features/documents/documentShareApi';
import { agentThreadComments, createMemoryDocumentApi, SAMPLE_MARKDOWN, SAMPLE_TOKEN, sampleDocument, sampleHtmlDocument } from '../helpers/documentReaderFixtures';
import '../../src/index.css';

// Login-free review page: ?state=local | uploaded | public | html | agent, optional ?theme=dark.
// Live mode against the configured cloud API (local test stacks only): ?attachmentId=&token=&accountId=&name=.
const params = new URLSearchParams(location.search);
const requested = params.get('state');
const state = requested === 'local' || requested === 'public' || requested === 'html' || requested === 'agent' ? requested : 'uploaded';
const theme = params.get('theme') === 'light' ? 'theme-light' : 'theme-dark';
document.body.classList.add('kordi-native-shell', theme);
document.body.dataset.kordiChatTheme = 'quiet';
document.body.style.margin = '0';

const owner: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: ['Priya', 'Theo'],
  agents: [{ name: 'Lab agent', mine: true }, { name: 'Field agent', mine: false }],
  canMessageAccount: () => true,
  messageAccount: () => undefined,
  sendAttachment: () => undefined,
  revealPath: () => undefined,
};

const reader: DocumentReaderHost = {
  ...owner,
  viewer: { accountId: 'acct_example_theo', displayName: 'Theo', kordiId: '555123456', avatarUrl: null },
};

// Every block type the reader styles, after the sample, so one page reviews them all.
const SHOWCASE = [
  '### Next steps',
  '- [x] Collect the interview notes\n- [ ] Draft the turn-taking section',
  '> Each person keeps their own agent; the group sees what the agents share.',
  '```ts\nconst turn = await room.nextSpeaker({ agents, people });\n```',
  '```\n```',
  '---',
];
const sample = sampleDocument('owner');
const ownerDocument = {
  ...sample,
  ...(state === 'agent' ? { comments: agentThreadComments(), reactions: [] } : {}),
  blocks: [...sample.blocks, ...SHOWCASE.map((source, index) => ({ id: `b${sample.blocks.length + index}`, source, html: '' }))],
};
const OWNER_MARKDOWN = [SAMPLE_MARKDOWN, ...SHOWCASE].join('\n\n');
const { api, calls } = createMemoryDocumentApi(state === 'public' ? sampleDocument('public') : state === 'html' ? sampleHtmlDocument('owner') : ownerDocument, 400);
// The review page records what the mock server received (saves, comments, reactions) for end-to-end checks.
Object.assign(window, { __documentReaderCalls: calls });
// The app installs this at startup; the review page does too so selection behaves as in the app.
installCopySurfaceSelectionTracking(document);

// A small authored HTML page: its own cards, grid and button must survive the app theme.
const STYLED_HTML = `<!doctype html><html><head><title>Prototype</title><style>
  .wrap { padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .card { background: #fafafa; color: #1f2937; border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; }
  .card h2 { font-size: 14px; margin: 0 0 6px; color: #4338ca; }
  .card p { margin: 0; font-size: 13px; line-height: 1.5; }
  button { margin-top: 14px; padding: 8px 14px; border: 0; border-radius: 999px; background: #4338ca; color: #fff; font-weight: 600; }
</style></head><body><div class="wrap">
  <h1>Prototype review</h1>
  <div class="grid">
    <div class="card"><h2>Turn-taking</h2><p>Agents wait for a mention before replying in a busy thread.</p></div>
    <div class="card"><h2>Private context</h2><p>Each agent reads only what its owner shared.</p></div>
  </div>
  <button type="button">Start review</button>
  <p>Notes live in <a href="https://kordi.ai/">the shared doc</a>.</p>
</div></body></html>`;
const htmlDocument = sampleHtmlDocument('owner');

function Panel({ shareOpen }: { shareOpen: boolean }) {
  if (state === 'html') {
    return <DocumentReader path="/Users/example/notes/prototype.html" localSource={STYLED_HTML} attachmentId={htmlDocument.attachmentId} initialDocument={htmlDocument} api={api} initialShareOpen={shareOpen} />;
  }
  if (state === 'local') {
    return <DocumentReader path="/Users/example/notes/related-work.md" localSource={OWNER_MARKDOWN} dateLabel="Oct 9, 2026" api={api} initialShareOpen={shareOpen} />;
  }
  if (state === 'public') {
    return <DocumentReader shareToken={SAMPLE_TOKEN} api={api} />;
  }
  return <DocumentReader path="/Users/example/notes/related-work.md" localSource={OWNER_MARKDOWN} attachmentId={ownerDocument.attachmentId} initialDocument={ownerDocument} api={api} initialShareOpen={shareOpen} />;
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
