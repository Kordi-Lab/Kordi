import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { createMemoryDocumentApi, SAMPLE_HTML, SAMPLE_MARKDOWN, sampleDocument, sampleHtmlDocument } from './helpers/documentReaderFixtures';
import { createDocumentShareApi } from '../src/features/documents/documentShareApi';
import { resolveDocumentTheme } from '../src/features/documents/documentTheme';
import { withJsdomRoot } from './helpers/mountWithJsdom';

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

    assert.equal(host_.querySelector('.app-document-title')?.textContent, 'Kordi related work');
    assert.match(host_.querySelector('.app-document-pill')?.textContent ?? '', /Oct 9, 2026/);
    assert.equal(host_.querySelector('.app-document-mention')?.textContent, '@Alex Morgan');
    assert.equal(host_.querySelector('.app-document-badge')?.textContent, 'In Kordi');
    assert.equal(host_.querySelectorAll('[data-document-block]').length, document.blocks.length - 1, 'the title heading is the page title');

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

test('a Mac-hosted document offers Upload to Kordi and then shows In Kordi', async () => {
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
    assert.equal(root.querySelector('.app-document-badge')?.textContent, 'In Kordi');
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

test('HTML documents carry the app theme: one transparent surface, app colors, and the color scheme', async () => {
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
    assert.match(srcdoc, /html, body \{ background: transparent !important;/);
    assert.ok(srcdoc.indexOf('data-kordi-artifact-rail-fit') < srcdoc.indexOf('data-kordi-document-theme'), 'the theme follows the rail-fit rules');
    assert.equal(frame.style.background, 'transparent');
    assert.equal(frame.getAttribute('allowtransparency'), 'true');

    const section = root.querySelector('.app-document-reader') as HTMLElement;
    section.style.setProperty('--utility-foreground', 'rgb(17, 24, 39)');
    section.style.setProperty('--app-markdown-link', 'rgb(37, 99, 235)');
    const theme = resolveDocumentTheme(section);
    assert.equal(theme.scheme, 'light');
    assert.equal(theme.foreground, 'rgb(17, 24, 39)');
    assert.equal(theme.link, 'rgb(37, 99, 235)');
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

function selectionMenuButtons(root: HTMLElement) {
  const menu = root.querySelector('[role="toolbar"][aria-label="Selection"] .app-document-selection-bar');
  assert.ok(menu, 'the selection menu is open');
  return Array.from(menu.querySelectorAll('button')).map((entry) => entry.getAttribute('aria-label'));
}

/** Selects `text` inside a block the way a mouse drag does, then fires `selectionchange`. */
async function selectText(root: HTMLElement, blockId: string, text: string, collapsed = false) {
  const block = root.querySelector(`[data-document-block="${blockId}"] .app-document-markdown`) as HTMLElement;
  const walker = block.ownerDocument.createTreeWalker(block, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.nodeValue?.indexOf(text) ?? -1;
    if (at < 0) continue;
    const range = block.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, collapsed ? at : at + text.length);
    const selection = block.ownerDocument.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => { block.ownerDocument.dispatchEvent(new block.ownerDocument.defaultView!.Event('selectionchange')); });
    return;
  }
  assert.fail(`text "${text}" in ${blockId}`);
}

const FORMAT_LABELS = ['Text style', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Code', 'Highlight', 'List', 'Link'];

test('a click without a range opens no menu, and a read-only viewer gets comment and react only', async () => {
  await withJsdomRoot(async (mount) => {
    const document = { ...sampleDocument('member'), viewerCan: { share: false, react: true, comment: true, askAgent: true, edit: false } };
    const { api } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await selectText(root, 'b3', 'clearest niche', true);
    assert.equal(root.querySelector('[aria-label="Selection"]'), null);
    await selectText(root, 'b3', 'clearest niche');
    assert.deepEqual(selectionMenuButtons(root), ['Comment', 'React']);
    assert.equal(root.querySelector('.app-document-block.is-selected'), null, 'no whole-block highlight');
    assert.equal(root.querySelector('[aria-label="Code block"]'), null, 'no insert tools for read-only documents');
  });
});

test('an editable cloud document formats the selected text, restores the selection, and saves', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const root = await mount(withHost(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
    await selectText(root, 'b3', 'clearest niche');
    const labels = selectionMenuButtons(root);
    assert.deepEqual(labels.slice(0, 2), ['Comment', 'React']);
    for (const label of FORMAT_LABELS) assert.ok(labels.includes(label), `${label} is in the menu`);

    await click(root.querySelector('[aria-label="Bold"]') as HTMLElement);
    assert.ok(root.querySelector('[data-document-block="b3"] strong'), 'the bold text renders');
    assert.equal(root.ownerDocument.defaultView!.getSelection()!.toString(), 'clearest niche', 'the same text stays selected');
    assert.equal(root.querySelector('[aria-label="Bold"]')?.getAttribute('aria-pressed'), 'true');

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    const save = calls.find((call) => call.method === 'saveDocumentContent');
    const input = save?.args[1] as { baseRevision: number; source: string };
    assert.equal(input.baseRevision, 3);
    assert.match(input.source, /the \*\*clearest niche\*\* for Kordi/);
  });
});

test('a Mac-hosted draft keeps the full menu and Aa changes the block style', async () => {
  await withJsdomRoot(async (mount) => {
    const { api } = createMemoryDocumentApi(sampleDocument('owner'));
    const root = await mount(withHost(createElement(DocumentReader, { path: '/Users/example/notes/format-test.md', localSource: SAMPLE_MARKDOWN, api })));
    await selectText(root, 'b2', 'end-to-end');
    const labels = selectionMenuButtons(root);
    for (const label of FORMAT_LABELS) assert.ok(labels.includes(label), `${label} is in the menu`);
    await click(root.querySelector('[aria-label="Text style"]') as HTMLElement);
    await click(Array.from(root.querySelectorAll('[role="menuitemradio"]')).find((entry) => entry.textContent?.includes('Heading 2')) as HTMLElement);
    assert.equal(root.querySelector('[data-document-block="b2"] .app-document-markdown > div')?.className.includes('font-semibold'), true);

    await click(root.querySelector('[aria-label="Checklist"]') as HTMLElement);
    assert.match(root.querySelector('[data-document-block="b3"]')?.textContent ?? '', /Task/, 'checklist lands after the current block');
  });
});
