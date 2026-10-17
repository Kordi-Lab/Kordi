import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';

import type { Editor } from '@tiptap/core';

import { ErrorBoundary, PaneErrorBoundary } from '../src/components/ErrorBoundary';
import { errorSummary } from '../src/lib/renderErrors';
import { DocumentReader } from '../src/features/documents/DocumentReader';
import { splitMarkdownBlocks } from '../src/features/documents/documentBlocks';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

/** JSDOM has no layout: the bubble menu measures the selection through Range rects. */
function stubLayout() {
  const view = globalThis.window as unknown as Window & typeof globalThis;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
}

/** Records what error boundaries report (`reportError`, which Node lacks). */
async function capturingErrors(run: (lines: string[]) => Promise<void>) {
  const lines: string[] = [];
  const target = globalThis as { reportError?: (error: unknown) => void };
  const original = target.reportError;
  target.reportError = (error: unknown) => { lines.push(error instanceof Error ? error.message : String(error)); };
  try {
    await run(lines);
  } finally {
    target.reportError = original;
  }
}

const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const PRIVATE_TEXT = 'Quarterly numbers stay inside the team';

/** An agent-written document with list items that start with a heading and with a nested list. */
function agentDocument(): DocumentResponse {
  const source = [
    '# Launch notes',
    `${PRIVATE_TEXT}.`,
    '- ## Summary\n  The short version.',
    '- - First idea\n  - Second idea',
  ].join('\n\n');
  return {
    ...sampleDocument('owner'),
    title: 'Launch notes',
    blocks: splitMarkdownBlocks(source).map((block) => ({ id: block.id, source: block.source, html: '' })),
    reactions: [],
    comments: [],
  };
}

function Thrower({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

test('a document with list items the schema refuses opens in the editor, and opening it saves nothing', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    const document = agentDocument();
    const { api, calls } = createMemoryDocumentApi(document);
    const view: { editor: Editor | null } = { editor: null };
    const root = await mount(createElement(DocumentReader, {
      attachmentId: document.attachmentId,
      initialDocument: document,
      api,
      onEditor: (editor: Editor | null) => { view.editor = editor; },
    }));
    await waitForReactCondition(() => Boolean(view.editor && root.querySelector('.ProseMirror li h2')), 'the editor shows the heading inside the item');
    assert.equal(root.querySelector('.app-document-fallback'), null);
    assert.ok(root.querySelector('.ProseMirror li ul li')?.textContent?.includes('First idea'));
    await settle(900);
    assert.equal(calls.filter((call) => call.method === 'saveDocumentContent').length, 0, 'an unedited document is not rewritten');
  });
});

test('an editor that fails shows the text in the document area only, and logs no document content', async () => {
  await capturingErrors(async (lines) => {
    await withJsdomRoot(async (mount) => {
      stubLayout();
      const document = agentDocument();
      const { api } = createMemoryDocumentApi(document);
      const root = await mount(createElement('div', null,
        createElement('nav', { id: 'sidebar' }, 'Chats'),
        createElement(DocumentReader, {
          attachmentId: document.attachmentId,
          initialDocument: document,
          api,
          onEditor: (editor: Editor | null) => {
            if (editor) throw new Error(`Invalid content for node listItem: <heading("${PRIVATE_TEXT}")>`);
          },
        })));
      await waitForReactCondition(() => Boolean(root.querySelector('.app-document-fallback')), 'the fallback shows');
      const fallback = root.querySelector('.app-document-fallback');
      assert.equal(fallback?.getAttribute('role'), 'alert');
      assert.match(fallback?.querySelector('pre')?.textContent ?? '', /- ## Summary\n {2}The short version\./);
      assert.ok(fallback?.textContent?.includes(PRIVATE_TEXT), 'the reader can still read the document');
      // The rest of the app and the document's own header stay.
      assert.equal(root.querySelector('#sidebar')?.textContent, 'Chats');
      assert.ok(root.querySelector('.app-document-header-wrap'));
      const summary = lines.filter((line) => line.startsWith('[documents]'));
      assert.deepEqual(summary, ['[documents] Error: Invalid content for node listItem']);
    });
  });
});

test('a failed area resets when its key changes', async () => {
  await capturingErrors(async () => {
    await withJsdomRoot(async (mount, root) => {
      const render = (resetKey: string, child: ReactNode) => createElement(ErrorBoundary, {
        area: 'documents',
        resetKey,
        fallback: () => createElement('p', { id: 'fallback' }, 'Fallback'),
      }, child);
      const host = await mount(render('doc-a', createElement(Thrower, { message: 'broken' })));
      assert.equal(host.querySelector('#fallback')?.textContent, 'Fallback');
      await act(async () => { root.render(render('doc-a', createElement('p', { id: 'content' }, 'Content'))); });
      assert.ok(host.querySelector('#fallback'), 'the same document keeps its fallback');
      await act(async () => { root.render(render('doc-b', createElement('p', { id: 'content' }, 'Content'))); });
      assert.equal(host.querySelector('#content')?.textContent, 'Content');
    });
  });
});

test('a shell pane that fails leaves the other panes running', async () => {
  await capturingErrors(async (lines) => {
    await withJsdomRoot(async (mount) => {
      const root = await mount(createElement('div', null,
        createElement(PaneErrorBoundary, { area: 'sidebar' }, createElement('aside', { id: 'sidebar' }, 'Chats')),
        createElement('main', null, createElement(PaneErrorBoundary, { area: 'main' }, createElement(Thrower, { message: 'main pane failed' })))));
      assert.equal(root.querySelector('#sidebar')?.textContent, 'Chats');
      assert.ok(root.querySelector('main .app-pane-fallback'));
      assert.ok(lines.includes('[main] Error: main pane failed'));
    });
  });
  // The shell wraps each of its panes.
  const frame = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
  for (const area of ['sidebar', 'main', 'detail']) assert.match(frame, new RegExp(`<PaneErrorBoundary area="${area}">`));
});

test('error summaries keep the kind and drop the content after the colon', () => {
  const error = new Error('Invalid content for node listItem: <heading("private text")>');
  error.name = 'TransformError';
  assert.equal(errorSummary(error), 'TransformError: Invalid content for node listItem');
  assert.equal(errorSummary('not an error'), 'Unknown error');
});
