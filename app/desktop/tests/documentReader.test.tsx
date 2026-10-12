import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { comment, createMemoryDocumentApi, reaction, SAMPLE_HTML, SAMPLE_MARKDOWN, sampleDocument, sampleHtmlDocument } from './helpers/documentReaderFixtures';
import { createDocumentShareApi } from '../src/features/documents/documentShareApi';
import { hasAuthorPageBackground, resolveDocumentTheme, themedDocumentSource, FALLBACK_DOCUMENT_THEME } from '../src/features/documents/documentTheme';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const host: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_viewer', displayName: 'Priya', kordiId: '987654321', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: ['Theo'],
  canMessageAccount: () => true,
  messageAccount: () => undefined,
};

function withHost(element: ReturnType<typeof createElement>, value = host) {
  return createElement(DocumentReaderHostContext.Provider, { value }, element);
}

function button(root: ParentNode, label: string) {
  const match = Array.from(root.querySelectorAll('button')).find((candidate) => (
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
  ));
  assert.ok(match, `button "${label}" is rendered`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('the reader shows the header, blocks, reaction pills, and open comment threads', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const host_ = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));

    await waitForReactCondition(() => Boolean(host_.querySelector('.ProseMirror > h1')), 'the editor loads');
    assert.equal(host_.querySelector('.app-document-header-title'), null, 'the document heading is the title; the header shows none');
    assert.equal(host_.querySelector('.ProseMirror > h1')?.textContent, 'Kordi related work');
    assert.match(host_.querySelector('.app-document-pill')?.textContent ?? '', /Oct 9, 2026/);
    assert.equal(host_.querySelector('.app-document-mention')?.textContent, '@Alex Morgan');
    assert.equal(host_.querySelector('.app-document-badge'), null, 'cloud documents carry no badge');
    assert.doesNotMatch(host_.textContent ?? '', /Tab 1/, 'no in-document tabs');
    assert.equal(Boolean(host_.querySelector('.app-document-insertbar [aria-haspopup="menu"]')), false, 'no tab dropdown');
    assert.ok(host_.querySelector('.app-document-insertbar [aria-label="Table"]'), 'the insert tools stay');
    assert.equal(host_.querySelector('.app-document-address'), null, 'Markdown has no browser bar');
    const topLevel = host_.querySelectorAll('.ProseMirror > [data-id], .ProseMirror > .tableWrapper > table[data-id]');
    assert.equal(topLevel.length, document.blocks.length, 'every block is in the editor');

    const thumbs = button(host_, '👍 2');
    assert.equal(thumbs.getAttribute('aria-pressed'), 'true');
    assert.equal(button(host_, '❤️ 1').getAttribute('aria-pressed'), 'false');
    assert.match(host_.textContent ?? '', /what does "clearest niche" mean here\?/);
    assert.match(host_.textContent ?? '', /Lab agent is working/);
    assert.match(host_.textContent ?? '', /Yes, 16 interviews\./);
    assert.doesNotMatch(host_.textContent ?? '', /Resolved thread/);

    await click(thumbs);
    const toggle = calls.find((call) => call.method === 'toggleReaction');
    assert.deepEqual(toggle?.args, [{ kind: 'attachment', attachmentId: 'att_example_doc' }, { blockId: 'b3', reaction: '👍' }]);
    assert.equal(button(host_, '👍 1').getAttribute('aria-pressed'), 'false');

    await click(host_.querySelector('.app-document-mention') as HTMLElement);
    const people = host_.querySelector('.app-document-people');
    assert.match(people?.textContent ?? '', /Alex Morgan/);
    assert.match(people?.textContent ?? '', /Kordi 123 456 789/);
    assert.ok(button(people as HTMLElement, 'Message'));
  });
});

test('the People card hides Message when the author is the viewer', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api } = createMemoryDocumentApi(document);
    const self = { ...host, viewer: { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null } };
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api }), self));
    await click(root.querySelector('.app-document-mention') as HTMLElement);
    const people = root.querySelector('.app-document-people') as HTMLElement;
    assert.equal(Array.from(people.querySelectorAll('button')).some((entry) => entry.textContent === 'Message'), false);
  });
});

test('the Share popover offers the link switch and confirms before turning the link off', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await click(button(root, 'Share'));

    const popover = root.querySelector('.app-document-share') as HTMLElement;
    assert.ok(popover);
    assert.equal(Array.from(popover.querySelectorAll('button')).some((entry) => entry.textContent === 'Upload to Kordi'), false);
    const linkSwitch = popover.querySelector('[role="switch"][aria-label="Anyone with the link"]') as HTMLElement;
    assert.equal(linkSwitch.getAttribute('aria-checked'), 'true');
    assert.match(popover.textContent ?? '', /kordi\.ai\/d\/kordi_ds_/);
    assert.equal(popover.querySelector('[aria-label="Readers can ask Lab agent"]')?.getAttribute('aria-checked'), 'true');
    assert.ok(button(popover, 'Share link'));

    await click(linkSwitch);
    const dialog = globalThis.document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
    assert.ok(dialog, 'turning the link off asks first');
    assert.match(dialog.textContent ?? '', /Turn off the link\?/);
    assert.match(dialog.textContent ?? '', /People in the session keep access\./);
    assert.equal(calls.some((call) => call.method === 'revokeShare'), false);

    await click(button(dialog, 'Turn off'));
    assert.deepEqual(calls.find((call) => call.method === 'revokeShare')?.args, ['docshare_example']);
    assert.equal(root.querySelector('[role="switch"][aria-label="Anyone with the link"]')?.getAttribute('aria-checked'), 'false');
  });
});

test('a document without a leading heading shows its file-name title in the header', async () => {
  await withJsdomRoot(async (mount) => {
    const base = sampleDocument('owner');
    const document = { ...base, title: 'meeting-notes', fileName: 'meeting-notes.md', blocks: base.blocks.slice(2) };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await waitForReactCondition(() => Boolean(root.querySelector('.ProseMirror > p')), 'the editor loads');
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'meeting-notes');
    assert.ok(root.querySelector('.app-document-header.has-title'));
    assert.match(root.querySelector('.app-document-pill')?.textContent ?? '', /Oct 9, 2026/);
  });
});

test('a Mac-hosted document offers Upload to Kordi and then drops the On this Mac badge', async () => {
  await withJsdomRoot(async (mount) => {
    const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'));
    const path = '/Users/example/notes/upload-test.md';
    const root = await mount(withHost(createElement(DocumentReader, { path, localSource: SAMPLE_MARKDOWN, api, dateLabel: '09:31' })));

    assert.equal(root.querySelector('.app-document-badge')?.textContent, 'On this Mac');
    assert.equal(root.querySelector('.app-document-mention')?.textContent, '@Priya');
    assert.equal(root.querySelectorAll('.app-document-reaction').length, 0);
    await click(button(root, 'Share'));
    const popover = root.querySelector('.app-document-share') as HTMLElement;
    assert.equal(popover.querySelector('[aria-label="Anyone with the link"]'), null, 'link controls wait for the upload');
    assert.equal(button(popover, 'Send in Kordi').disabled, true);

    await click(button(popover, 'Upload to Kordi'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls.find((call) => call.method === 'uploadDocument')?.args, [path, 'text/markdown']);
    assert.deepEqual(calls.find((call) => call.method === 'createShare')?.args, ['att_example_doc', { sessionId: 'session_example', readersCanAskAgent: true }]);
    assert.equal(root.querySelector('.app-document-badge'), null);
  });
});

test('an uploaded HTML document loads the authenticated raw route into a sandboxed srcdoc frame', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleHtmlDocument('member');
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

    assert.deepEqual(calls.find((call) => call.method === 'getDocumentRaw')?.args, ['att_example_html']);
    const frame = root.querySelector('iframe.app-document-frame') as HTMLIFrameElement;
    assert.ok(frame, 'the HTML renders in an iframe');
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.equal(frame.hasAttribute('src'), false);
    assert.match(frame.getAttribute('srcdoc') ?? '', /Shared as HTML\./);
    assert.doesNotMatch(root.textContent ?? '', /No preview/);
  });
});

test('HTML documents show as in a browser: app colors at zero specificity, a viewport, no forced widths', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleHtmlDocument('member');
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(createElement('div', {
      className: 'kordi-app theme-light',
      style: { '--utility-foreground': 'rgb(17, 24, 39)', '--app-markdown-link': 'rgb(37, 99, 235)' },
    }, withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api }))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

    const frame = root.querySelector('iframe.app-document-frame') as HTMLIFrameElement;
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    assert.match(srcdoc, /data-kordi-document-theme/);
    assert.match(srcdoc, /color-scheme: light;/);
    assert.match(srcdoc, /<meta name="color-scheme" content="light">/);
    assert.match(srcdoc, /:where\(html, body\) \{ background: transparent; color: rgb\(17, 24, 39\);/);
    assert.match(srcdoc, /:where\(a:link, a:visited\) \{ color: rgb\(37, 99, 235\); \}/);
    assert.match(srcdoc, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.doesNotMatch(srcdoc, /overflow-x|min-width|!important/, 'nothing clips or forces the page');
    assert.doesNotMatch(srcdoc, /data-kordi-artifact/, 'no rail-fit rules');
    const theme_ = srcdoc.slice(srcdoc.indexOf('data-kordi-document-theme'));
    assert.match(theme_, /:where\(img, video\) \{ max-width: 100%;/);
    assert.doesNotMatch(theme_, /grid-template-columns|flex-wrap|button|pre|table/, 'the author design is not flattened');
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.equal(frame.style.background, 'transparent');
    assert.equal(frame.getAttribute('allowtransparency'), 'true');
    assert.equal(frame.closest('.app-document-article'), null, 'the page is not inside the padded article');
    assert.equal(frame.parentElement?.className, 'app-document-body is-html');
    assert.equal(root.querySelector('.app-document-insertbar'), null, 'no toolbar under the browser bar');
    assert.doesNotMatch(root.textContent ?? '', /Tab 1/);

    const section = root.querySelector('.app-document-reader') as HTMLElement;
    section.style.setProperty('--utility-foreground', 'rgb(17, 24, 39)');
    section.style.setProperty('--app-markdown-link', 'rgb(37, 99, 235)');
    const theme = resolveDocumentTheme(section);
    assert.equal(theme.scheme, 'light');
    assert.equal(theme.foreground, 'rgb(17, 24, 39)');
    assert.equal(theme.link, 'rgb(37, 99, 235)');
  });
});

test('an author design survives: a card background and grid stay, and a page with its own background gets no app colors', async () => {
  const card = '<!doctype html><html><head><style>.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .card { background: #fafafa; padding: 12px; }</style></head><body><div class="grid"><div class="card">One</div><div class="card">Two</div></div></body></html>';
  const themed = themedDocumentSource(card, FALLBACK_DOCUMENT_THEME);
  assert.equal(hasAuthorPageBackground(card), false);
  const { JSDOM } = await import('jsdom');
  const view = new JSDOM(themed).window;
  const first = view.document.querySelector('.card') as HTMLElement;
  assert.equal(view.getComputedStyle(first).backgroundColor, 'rgb(250, 250, 250)', 'the author card background survives');
  assert.equal(view.getComputedStyle(view.document.querySelector('.grid') as HTMLElement).gridTemplateColumns, '1fr 1fr', 'the author grid survives');
  view.close();

  const whitePage = '<!doctype html><html><head><style>body { background: #fff; }</style></head><body><p>Report</p></body></html>';
  assert.equal(hasAuthorPageBackground(whitePage), true);
  assert.equal(hasAuthorPageBackground('<body style="background-color: white"><p>x</p></body>'), true);
  const themedWhite = themedDocumentSource(whitePage, FALLBACK_DOCUMENT_THEME);
  assert.doesNotMatch(themedWhite, /:where\(html, body\)|color-scheme/, 'its own surface and colors stay');
  assert.doesNotMatch(themedWhite, /overflow-x/);
  assert.match(themedWhite, /<meta name="viewport"/);

  const withViewport = '<html><head><meta name="viewport" content="width=600"></head><body><p>x</p></body></html>';
  assert.equal(themedDocumentSource(withViewport, FALLBACK_DOCUMENT_THEME).match(/name="viewport"/g)?.length, 1, 'an author viewport is kept as the only one');
  assert.match(themedDocumentSource('<p>Fragment</p>', FALLBACK_DOCUMENT_THEME), /^<!doctype html><html><head><meta name="viewport"[\s\S]*<body><p>Fragment<\/p><\/body><\/html>$/);
});

test('the browser bar shows the file name and reloads the page from the raw route', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleHtmlDocument('member');
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    const rawCalls = () => calls.filter((call) => call.method === 'getDocumentRaw').length;

    const bar = root.querySelector('.app-document-header.is-browser') as HTMLElement;
    assert.ok(bar, 'the header is a browser bar');
    assert.equal(bar.querySelector('.app-document-address')?.textContent, 'lab-notes.html');
    assert.equal(bar.querySelector('.app-document-header-title'), null);
    assert.equal(bar.querySelector('.app-document-mention')?.textContent, '@Alex Morgan');
    assert.match(bar.querySelector('.app-document-pill')?.textContent ?? '', /Oct 9, 2026/);
    assert.equal(rawCalls(), 1);

    const before = root.querySelector('iframe.app-document-frame');
    await click(button(bar, 'Reload'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.equal(rawCalls(), 2, 'reload fetches the raw HTML again');
    const after = root.querySelector('iframe.app-document-frame') as HTMLIFrameElement;
    assert.ok(after && after !== before, 'the frame renders again');
    assert.match(after.getAttribute('srcdoc') ?? '', /Shared as HTML\./);
  });
});

test('reactions and comments of an HTML document sit in the bottom bar', async () => {
  await withJsdomRoot(async (mount) => {
    const document = {
      ...sampleHtmlDocument('member'),
      reactions: [reaction('b0', '👍', 'Theo'), reaction('b0', '👍', 'Priya', true)],
      comments: [
        comment({ commentId: 'doccmt_html_1', blockId: 'b0', body: 'The second card needs a source.' }),
        comment({ commentId: 'doccmt_html_2', blockId: 'b0', parentCommentId: 'doccmt_html_1', body: 'Added.', createdAt: '2026-10-09T10:20:00Z' }),
      ],
    };
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

    const bar = root.querySelector('.app-document-annotation-bar') as HTMLElement;
    assert.ok(bar, 'the bar renders under the page');
    assert.equal(bar.previousElementSibling?.className, 'app-document-body is-html');
    assert.equal(root.querySelector('.app-document-body .app-document-reaction'), null, 'nothing in the page flow');
    assert.equal(button(bar, '👍 2').getAttribute('aria-pressed'), 'true');
    assert.equal(bar.querySelector('.app-document-annotation-popover'), null);
    assert.doesNotMatch(root.textContent ?? '', /The second card needs a source\./);

    await click(button(bar, '👍 2'));
    assert.deepEqual(calls.find((call) => call.method === 'toggleReaction')?.args, [{ kind: 'attachment', attachmentId: 'att_example_html' }, { blockId: 'b0', reaction: '👍' }]);

    const toggle = button(bar, 'Comments 2');
    await click(toggle);
    const popover = bar.querySelector('.app-document-annotation-popover') as HTMLElement;
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.match(popover.textContent ?? '', /The second card needs a source\./);
    assert.match(popover.textContent ?? '', /Added\./);
    assert.ok(popover.querySelector('.app-document-thread.is-new input'), 'a new comment can start here');

    await click(toggle);
    assert.equal(bar.querySelector('.app-document-annotation-popover'), null);
  });
});

test('a public HTML link renders through srcdoc from the share raw path', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleHtmlDocument('public');
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { shareToken: 'kordi_ds_EXAMPLEtokenEXAMPLEtokenEXAMPLEtoken0', initialDocument: document, api })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls.find((call) => call.method === 'getPublicDocumentRaw')?.args, [document.rawPath]);
    const frame = root.querySelector('iframe.app-document-frame') as HTMLIFrameElement;
    assert.equal(frame.hasAttribute('src'), false);
    assert.match(frame.getAttribute('srcdoc') ?? '', /Shared as HTML\./);
  });
});

test('the raw route is fetched with the bearer token', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const api = createDocumentShareApi({
    client: { request: async () => { throw new Error('unused'); } },
    loadSession: async () => ({ token: 'token_example', accountId: 'acct_example_viewer', expiresAt: '2026-12-31T00:00:00Z' }),
    baseUrl: () => 'https://cloud.example',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(SAMPLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(await api.getDocumentRaw('att_example_html'), SAMPLE_HTML);
  assert.equal(requests[0]?.url, 'https://cloud.example/v1/cloud/documents/att_example_html/raw');
  assert.deepEqual(requests[0]?.init.headers, { authorization: 'Bearer token_example' });
});
