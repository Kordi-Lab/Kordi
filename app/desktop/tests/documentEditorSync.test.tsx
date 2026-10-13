import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { Editor } from '@tiptap/core';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { createMemoryDocumentApi, SAMPLE_MARKDOWN, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

/** JSDOM has no layout: the bubble menu measures the selection through Range rects. */
function stubLayout() {
  const view = globalThis.window as unknown as Window & typeof globalThis;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
}

const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function openReader(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>, document: DocumentResponse, api: ReturnType<typeof createMemoryDocumentApi>['api'], extra: Record<string, unknown> = {}) {
  stubLayout();
  const view: { editor: Editor | null } = { editor: null };
  const root = await mount(createElement(DocumentReader, {
    attachmentId: document.attachmentId,
    initialDocument: document,
    api,
    onEditor: (editor: Editor | null) => { view.editor = editor; },
    ...extra,
  }));
  await waitForReactCondition(() => Boolean(view.editor && root.querySelector('.ProseMirror > h1')), 'the editor loads');
  return { root, view };
}

/** Top-level block holding `text`, with its id and start position. */
function blockWith(editor: Editor, text: string) {
  let found: { id: string; start: number } | null = null;
  editor.state.doc.forEach((node, offset) => { if (!found && node.textContent.includes(text)) found = { id: String(node.attrs.id), start: offset }; });
  assert.ok(found, `block with ${text}`);
  return found as { id: string; start: number };
}

function selectText(editor: Editor, text: string) {
  let from = -1;
  editor.state.doc.descendants((node, position) => {
    if (from < 0 && node.isText && node.text?.includes(text)) from = position + node.text.indexOf(text);
  });
  editor.commands.setTextSelection({ from, to: from + text.length });
}

const withBlock = (document: DocumentResponse, blockId: string, source: string, revision: number): DocumentResponse => ({
  ...document,
  revision,
  updatedAt: `2026-10-12T0${revision}:00:00Z`,
  blocks: document.blocks.map((block) => (block.id === blockId ? { ...block, source } : block)),
});

test('an edit is saved with its base revision, id comments, and the index-to-id map on the first stamped save', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const { view } = await openReader(mount, document, api);
    await act(async () => {
      selectText(view.editor!, 'clearest');
      view.editor!.chain().toggleBold().run();
    });
    await settle(900);
    const save = calls.find((call) => call.method === 'saveDocumentContent')?.args[1] as { baseRevision: number; source: string; blockIds: Record<string, string> };
    assert.equal(save.baseRevision, 3);
    assert.match(save.source, /the \*\*clearest\*\* niche/);
    assert.deepEqual(Object.keys(save.blockIds).sort(), document.blocks.map((block) => block.id).sort());
    for (const id of Object.values(save.blockIds)) assert.match(id, /^k:[a-z0-9]{8}$/);
    assert.ok(save.source.includes(`<!-- ${save.blockIds.b3} -->`), 'the paragraph carries the id it was stamped with');
  });
});

test('a remote change elsewhere keeps the caret where it was', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('member');
    const { api } = createMemoryDocumentApi(document);
    const { root, view } = await openReader(mount, document, api);
    const before = blockWith(view.editor!, 'Most published');
    await act(async () => { view.editor!.commands.setTextSelection(before.start + 6); });
    api.setStored(withBlock(document, 'b4', '## Coordination theory, revised elsewhere', 4));
    await act(async () => { notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: document.attachmentId, revision: 4, change: 'content' } }]); });
    await settle(450);
    assert.match(root.querySelector('.ProseMirror')?.textContent ?? '', /revised elsewhere/, 'the remote edit arrived');
    const after = blockWith(view.editor!, 'Most published');
    assert.equal(after.id, before.id);
    assert.equal(view.editor!.state.selection.from - after.start, 6, 'the caret stays at the same spot in the same block');
  });
});

test('when the block being typed into also changed remotely, the local text stays and the reader says so once', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('member');
    const { api } = createMemoryDocumentApi(document);
    const { root, view } = await openReader(mount, document, api);
    await act(async () => {
      const block = blockWith(view.editor!, 'That configuration');
      view.editor!.chain().setTextSelection(block.start + 1).insertContent('Local words. ').run();
    });
    api.setStored(withBlock(document, 'b3', 'Remote words replaced this paragraph.', 4));
    await act(async () => { notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: document.attachmentId, revision: 4, change: 'content' } }]); });
    await settle(450);
    const text = root.querySelector('.ProseMirror')?.textContent ?? '';
    assert.match(text, /Local words\. That configuration/);
    assert.doesNotMatch(text, /Remote words replaced/);
    assert.equal(root.querySelector('.app-document-toast')?.textContent, 'Updated elsewhere');
  });
});

test('read-only viewers get the same editor with editing off', async () => {
  await withJsdomRoot(async (mount) => {
    const document = { ...sampleDocument('member'), viewerCan: { share: false, react: true, comment: true, askAgent: true, edit: false } };
    const { api } = createMemoryDocumentApi(document);
    const { root, view } = await openReader(mount, document, api);
    assert.equal(view.editor!.isEditable, false);
    assert.equal(root.querySelector('.ProseMirror')?.getAttribute('contenteditable'), 'false');
    assert.equal(root.querySelector('[aria-label="Code block"]'), null, 'no insert tools');
  });
});

test('a Mac-hosted file keeps edits in the draft that Upload to Kordi saves after the upload', async () => {
  await withJsdomRoot(async (mount) => {
    const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'));
    stubLayout();
    const view: { editor: Editor | null } = { editor: null };
    const root = await mount(createElement(DocumentReader, { path: '/Users/example/notes/draft.md', localSource: SAMPLE_MARKDOWN, api, onEditor: (editor: Editor | null) => { view.editor = editor; } }));
    await waitForReactCondition(() => Boolean(view.editor && root.querySelector('.ProseMirror > h1')), 'the editor loads');
    await act(async () => {
      selectText(view.editor!, 'clearest');
      view.editor!.chain().toggleItalic().run();
    });
    const share = Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === 'Share')!;
    await act(async () => { share.click(); });
    const upload = Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === 'Upload to Kordi')!;
    await act(async () => { upload.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(calls.some((call) => call.method === 'uploadDocument'));
    const save = calls.find((call) => call.method === 'saveDocumentContent')?.args[1] as { source: string };
    assert.match(save.source, /the \*clearest\* niche/);
    // Let the reader finish switching to the uploaded document before the window goes away.
    await settle(1000);
  });
});
