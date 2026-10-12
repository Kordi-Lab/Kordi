import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { useCloudDocumentEdits } from '../src/features/documents/useCloudDocumentEdits';
import { MarkdownContent } from '../src/kordi-app/components';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

type Edits = ReturnType<typeof useCloudDocumentEdits>;

function withBlock(document: DocumentResponse, blockId: string, source: string, revision: number): DocumentResponse {
  return { ...document, revision, blocks: document.blocks.map((block) => (block.id === blockId ? { ...block, source } : block)) };
}

async function mountEdits(api: ReturnType<typeof createMemoryDocumentApi>['api'], initial: DocumentResponse) {
  const view: { edits: Edits | null; document: DocumentResponse; annotations: number } = { edits: null, document: initial, annotations: 0 };
  let rerender: () => Promise<void> = async () => undefined;
  function Harness() {
    view.edits = useCloudDocumentEdits({
      api,
      document: view.document,
      enabled: true,
      onDocument: (next) => { view.document = next; },
      onAnnotations: (reactions, comments) => { view.annotations += 1; view.document = { ...view.document, reactions, comments }; },
    });
    return null;
  }
  return {
    view,
    async start(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>) {
      await mount(createElement(Harness));
      rerender = () => mount(createElement(Harness)).then(() => undefined);
    },
    rerender: () => rerender(),
  };
}

const EDITED = '# Kordi related work <!-- k:aaaaaaaa -->\n\nAn edited paragraph. <!-- k:bbbbbbbb -->';

test('a save sends the editor Markdown with the revision it was based on and the first stamped ids', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => { harness.view.edits!.updateSource(EDITED, { b0: 'k:aaaaaaaa', b2: 'k:bbbbbbbb' }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    const save = calls.find((call) => call.method === 'saveDocumentContent');
    assert.ok(save, 'the edit is saved after the debounce');
    const [attachmentId, input] = save.args as [string, { baseRevision: number; source: string; blockIds?: Record<string, string> }];
    assert.equal(attachmentId, 'att_example_doc');
    assert.deepEqual(input, { baseRevision: 3, source: EDITED, blockIds: { b0: 'k:aaaaaaaa', b2: 'k:bbbbbbbb' } });
    assert.equal(harness.view.document.revision, 4);
    assert.deepEqual(harness.view.document.blocks.map((block) => block.id), ['k:aaaaaaaa', 'k:bbbbbbbb'], 'the server reads ids from the comments');
    assert.equal(harness.view.edits!.draft, null);
  });
});

test('a 409 hands the newer document over and saves again on its revision', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const remote = { ...document, revision: 5 };
    const { api, calls } = createMemoryDocumentApi(document, 0, { conflictWith: remote });
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => { harness.view.edits!.updateSource(EDITED); });
    await act(async () => { await harness.view.edits!.flush(); });
    assert.equal(harness.view.document.revision, 5, 'the editor gets the newer document to merge');
    assert.equal(harness.view.edits!.draft, EDITED, 'the draft waits for the merge');
    await harness.rerender();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    const saves = calls.filter((call) => call.method === 'saveDocumentContent').map((call) => call.args[1] as { baseRevision: number });
    assert.deepEqual(saves.map((save) => save.baseRevision), [3, 5]);
  });
});

const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test('document.updated events refetch once per burst; a newer revision merges content', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('member');
    const { api, calls } = createMemoryDocumentApi(document);
    api.setStored(withBlock(document, 'b2', 'Changed on another Mac.', 4));
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => {
      for (let count = 0; count < 3; count += 1) {
        notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 4, change: 'content' } }]);
      }
    });
    await settle(100);
    assert.equal(calls.filter((call) => call.method === 'getDocument').length, 0, 'debounced');
    await settle(350);
    assert.equal(calls.filter((call) => call.method === 'getDocument').length, 1, 'one refetch for the burst');
    assert.equal(harness.view.document.revision, 4);
    assert.equal(harness.view.document.blocks.find((block) => block.id === 'b2')?.source, 'Changed on another Mac.');
  });
});

test('annotation events refresh reactions and comments without touching a pending edit', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const remoteComment = { ...document.comments[0], commentId: 'doccmt_remote', body: 'Added on the iPhone', blockId: 'b2' };
    api.setStored({ ...document, comments: [...document.comments, remoteComment], reactions: [] });
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => { harness.view.edits!.updateSource(EDITED); });
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 3, change: 'annotations' } }]);
    });
    await settle(400);
    assert.equal(calls.filter((call) => call.method === 'getDocument').length, 1, 'same revision still refetches');
    assert.equal(harness.view.annotations, 1);
    assert.ok(harness.view.document.comments.some((comment) => comment.body === 'Added on the iPhone'));
    await harness.rerender();
    assert.equal(harness.view.edits!.draft, EDITED, 'the pending edit stays');
    // Settle the pending save before the window goes away.
    await act(async () => { await harness.view.edits!.flush(); });
  });
});

test('Markdown renders <u>, ~~, ==, and <mark> and no other inline HTML', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownContent, { text: 'a <u>under</u> b ~~gone~~ c ==marked== d <mark>tagged</mark> e <b>raw</b>', tone: 'inherit' }));
  assert.match(markup, /<u[^>]*>under<\/u>/);
  assert.match(markup, /<s[^>]*>gone<\/s>/);
  assert.match(markup, /<mark class="app-markdown-mark">marked<\/mark>/);
  assert.match(markup, /<mark class="app-markdown-mark">tagged<\/mark>/);
  assert.match(markup, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(renderToStaticMarkup(createElement(MarkdownContent, { text: 'x == y', tone: 'inherit' })), /x == y/);
  const literal = renderToStaticMarkup(createElement(MarkdownContent, { text: 'a == b == c', tone: 'inherit' }));
  assert.match(literal, /a == b == c/);
  assert.doesNotMatch(literal, /<mark/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(MarkdownContent, { text: 'a ==b == c', tone: 'inherit' })), /<mark/);
});

test('pressing the selection menu keeps the text selection the app would otherwise clear', async () => {
  const { installCopySurfaceSelectionTracking } = await import('../src/features/contentSelection');
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement('div', null,
      createElement('p', { 'data-kordi-copy-surface': 'document' }, 'Selected words here'),
      createElement('div', { 'data-kordi-keeps-selection': 'true' }, createElement('button', { type: 'button', id: 'bold' }, 'B')),
      createElement('button', { type: 'button', id: 'elsewhere' }, 'Other')));
    const ownerDocument = root.ownerDocument;
    const stop = installCopySurfaceSelectionTracking(ownerDocument);
    const selectWords = () => {
      const range = ownerDocument.createRange();
      range.selectNodeContents(root.querySelector('p')!);
      ownerDocument.defaultView!.getSelection()!.removeAllRanges();
      ownerDocument.defaultView!.getSelection()!.addRange(range);
    };
    const press = (id: string) => root.querySelector(`#${id}`)!.dispatchEvent(new ownerDocument.defaultView!.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    try {
      selectWords();
      press('bold');
      assert.equal(ownerDocument.defaultView!.getSelection()!.toString(), 'Selected words here');
      press('elsewhere');
      assert.equal(ownerDocument.defaultView!.getSelection()!.toString(), '');
    } finally {
      stop();
    }
  });
});
