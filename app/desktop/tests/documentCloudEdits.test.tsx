import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { rebaseBlockEdits, UPDATED_ELSEWHERE, useCloudDocumentEdits } from '../src/features/documents/useCloudDocumentEdits';
import { MarkdownContent } from '../src/kordi-app/components';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

type Edits = ReturnType<typeof useCloudDocumentEdits>;

function withBlock(document: DocumentResponse, blockId: string, source: string, revision: number): DocumentResponse {
  return { ...document, revision, blocks: document.blocks.map((block) => (block.id === blockId ? { ...block, source } : block)) };
}

async function mountEdits(api: ReturnType<typeof createMemoryDocumentApi>['api'], initial: DocumentResponse) {
  const view: { edits: Edits | null; document: DocumentResponse } = { edits: null, document: initial };
  let rerender: () => Promise<void> = async () => undefined;
  function Harness() {
    view.edits = useCloudDocumentEdits({ api, document: view.document, enabled: true, onDocument: (next) => { view.document = next; } });
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

test('a save sends the whole source with the revision it was based on', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => { harness.view.edits!.editBlock('b2', 'An edited paragraph.'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    const save = calls.find((call) => call.method === 'saveDocumentContent');
    assert.ok(save, 'the edit is saved after the debounce');
    const [attachmentId, input] = save.args as [string, { baseRevision: number; source: string }];
    assert.equal(attachmentId, 'att_example_doc');
    assert.equal(input.baseRevision, 3);
    assert.equal(input.source, document.blocks.map((block) => (block.id === 'b2' ? 'An edited paragraph.' : block.source)).join('\n\n'));
    assert.equal(harness.view.document.revision, 4);
    assert.deepEqual(harness.view.edits!.edits, {});
  });
});

test('a 409 rebases block edits onto the server document and retries once', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const remote = withBlock(document, 'b4', '## Coordination theory, revised', 5);
    const { api, calls } = createMemoryDocumentApi(document, 0, { conflictWith: remote });
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => {
      harness.view.edits!.editBlock('b2', 'Mine, untouched remotely.');
      harness.view.edits!.editBlock('b4', '## Also changed here');
    });
    await act(async () => { await harness.view.edits!.flush(); });
    const saves = calls.filter((call) => call.method === 'saveDocumentContent');
    assert.equal(saves.length, 2, 'one retry after the conflict');
    const retry = saves[1].args[1] as { baseRevision: number; source: string };
    assert.equal(retry.baseRevision, 5);
    assert.match(retry.source, /Mine, untouched remotely\./);
    assert.match(retry.source, /## Coordination theory, revised/, 'a block changed on both sides keeps the remote text');
    assert.doesNotMatch(retry.source, /Also changed here/);
    await harness.rerender();
    assert.equal(harness.view.edits!.notice, UPDATED_ELSEWHERE);
  });
});

test('document.updated with a newer revision refetches the document', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('member');
    const { api, calls } = createMemoryDocumentApi(document);
    api.setStored(withBlock(document, 'b2', 'Changed on another Mac.', 4));
    const harness = await mountEdits(api, document);
    await harness.start(mount);
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 3 } }]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(calls.filter((call) => call.method === 'getDocument').length, 0, 'the shown revision is not older');
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 4 } }]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(calls.filter((call) => call.method === 'getDocument').length, 1);
    assert.equal(harness.view.document.revision, 4);
    assert.equal(harness.view.document.blocks.find((block) => block.id === 'b2')?.source, 'Changed on another Mac.');
  });
});

test('rebasing keeps edits on blocks the remote left alone', () => {
  const base = sampleDocument('owner');
  const remote = withBlock(base, 'b4', 'remote', 4);
  assert.deepEqual(rebaseBlockEdits(base, remote, { b2: 'mine', b4: 'mine too' }), { edits: { b2: 'mine' }, conflict: true });
  assert.deepEqual(rebaseBlockEdits(base, base, { b2: 'mine' }), { edits: { b2: 'mine' }, conflict: false });
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
