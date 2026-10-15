import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import {
  documentDisplayName,
  documentTitleFor,
  MAX_TITLE_REQUESTS,
  rememberDocumentTitle,
  requestDocumentTitle,
  resetDocumentTitlesForTests,
  type DocumentTitleFetch,
} from '../src/features/documents/documentTitles';
import { TranscriptFileAttachmentLink } from '../src/kordi-app/components/transcriptFileAttachmentLink';
import type { SessionArtifact } from '../src/kordi-app/types';
import { ArtifactListRow } from '../src/pages/ArtifactListRow';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const host: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_viewer', displayName: 'Priya', kordiId: '987654321', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: [],
};

const chatDocument: SessionArtifact = {
  id: 'attachment:att_untitled_2',
  path: 'Untitled 2.md',
  name: 'Untitled 2.md',
  kind: 'document',
  category: 'artifact',
  summary: '',
  attachmentId: 'att_untitled_2',
  timeLabel: '14:54',
};

const neverFetch: DocumentTitleFetch = () => new Promise(() => undefined);

function rowElement(artifact: SessionArtifact = chatDocument, fetchTitle: DocumentTitleFetch = neverFetch) {
  return createElement(ArtifactListRow, { artifact, location: '', isActive: false, participants: [], onSelect: () => undefined, fetchTitle });
}

function rowLabel(root: ParentNode) {
  return root.querySelector('[data-artifact-file-row="true"] span.font-medium');
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test.beforeEach(() => resetDocumentTitlesForTests());

test('a list shows the title only when it says more than the file name', () => {
  assert.equal(documentDisplayName('Untitled 2.md', 'xixi xhiqueuqoe'), 'xixi xhiqueuqoe');
  assert.equal(documentDisplayName('Untitled 2.md', 'Untitled 2'), 'Untitled 2.md');
  assert.equal(documentDisplayName('Untitled 2.md', '  '), 'Untitled 2.md');
  assert.equal(documentDisplayName('Untitled 2.md', null), 'Untitled 2.md');
});

test('an Artifacts row follows a rename from the sync stream and keeps the file name as its tooltip', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(rowElement());
    assert.equal(rowLabel(root)?.textContent, 'Untitled 2.md');

    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_untitled_2', revision: 3, change: 'title', title: 'xixi xhiqueuqoe' } }]);
    });
    assert.equal(rowLabel(root)?.textContent, 'xixi xhiqueuqoe');
    assert.equal(rowLabel(root)?.getAttribute('title'), 'Untitled 2.md');
    assert.match(root.innerHTML, /title="Markdown"/, 'the file-type badge stays');
    assert.match(root.innerHTML, /14:54/, 'the time stays');
  });
});

test('only rename events change a title', () => {
  notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_untitled_2', revision: 4, change: 'content', title: 'Not a rename' } }]);
  assert.equal(documentTitleFor('att_untitled_2'), null);
});

test('a reader that loads a document reports its title to the lists, and a rename shows before the server answers', async () => {
  const document: DocumentResponse = { ...sampleDocument('owner'), attachmentId: 'att_untitled_2', title: 'Q4 plan', fileName: 'Untitled 2.md' };
  const memory = createMemoryDocumentApi(document);
  let finishRename: (() => void) | null = null;
  const api = {
    ...memory.api,
    renameDocument: (attachmentId: string, title: string) => new Promise<DocumentResponse>((resolve) => {
      finishRename = () => resolve({ ...document, attachmentId, title });
    }),
  };
  await withJsdomRoot(async (mount) => {
    await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(DocumentReader, { attachmentId: 'att_untitled_2', api })));
    await waitForReactCondition(() => documentTitleFor('att_untitled_2') === 'Q4 plan', 'the loaded title is known');
    assert.match(renderToStaticMarkup(rowElement()), />Q4 plan</);
  });

  // The rename action of #1777, driven through the reader hook's state.
  resetDocumentTitlesForTests();
  const untitled: DocumentResponse = { ...document, title: 'Untitled 2', blocks: document.blocks.slice(2) };
  await withJsdomRoot(async (mount) => {
    Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(DocumentReader, { attachmentId: 'att_untitled_2', initialDocument: untitled, api })));
    await waitForReactCondition(() => Boolean(root.querySelector('.ProseMirror')), 'the editor loads');
    const title = root.querySelector('.app-document-header-title') as Element;
    await act(async () => { title.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Title"]') as HTMLInputElement;
    input.value = 'xixi xhiqueuqoe';
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    assert.equal(documentTitleFor('att_untitled_2'), 'xixi xhiqueuqoe', 'the rename shows at once');
    await act(async () => { finishRename?.(); });
    await settle();
    assert.equal(documentTitleFor('att_untitled_2'), 'xixi xhiqueuqoe');
  });
});

test('a visible row fetches a missing title once and shows it', async () => {
  const asked: string[] = [];
  const fetchTitle: DocumentTitleFetch = async (attachmentId) => { asked.push(attachmentId); return { title: 'Launch notes' }; };
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement('div', null, rowElement(chatDocument, fetchTitle), rowElement({ ...chatDocument, id: 'copy' }, fetchTitle)));
    await waitForReactCondition(() => rowLabel(root)?.textContent === 'Launch notes', 'the fetched title shows');
    assert.deepEqual(asked, ['att_untitled_2'], 'one request per document');
  });
});

test('a failed title fetch leaves the file name and is not retried', async () => {
  let asked = 0;
  const fetchTitle: DocumentTitleFetch = async () => { asked += 1; throw new Error('offline'); };
  await withJsdomRoot(async (mount) => {
    const root = await mount(rowElement(chatDocument, fetchTitle));
    await settle();
    await settle();
    assert.equal(rowLabel(root)?.textContent, 'Untitled 2.md');
    assert.equal(rowLabel(root)?.getAttribute('title'), null);
  });
  requestDocumentTitle('att_untitled_2', fetchTitle);
  await settle();
  assert.equal(asked, 1);
});

test('files without a cloud copy and other file types are never fetched', async () => {
  const asked: string[] = [];
  const fetchTitle: DocumentTitleFetch = async (attachmentId) => { asked.push(attachmentId); return { title: 'Nope' }; };
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement('div', null,
      rowElement({ ...chatDocument, id: 'local', path: '/Users/example/notes.md', name: 'notes.md', attachmentId: null }, fetchTitle),
      rowElement({ ...chatDocument, id: 'pdf', path: 'paper.pdf', name: 'paper.pdf', kind: 'file', attachmentId: 'att_pdf' }, fetchTitle)));
    await settle();
    assert.deepEqual(asked, []);
    assert.match(root.innerHTML, />notes\.md</);
  });
});

test('title requests run a few at a time', async () => {
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const fetchTitle: DocumentTitleFetch = (attachmentId) => {
    running += 1;
    peak = Math.max(peak, running);
    return new Promise((resolve) => { releases.push(() => { running -= 1; resolve({ title: `Title ${attachmentId}` }); }); });
  };
  for (const id of ['a', 'b', 'c', 'd', 'e']) requestDocumentTitle(id, fetchTitle);
  await settle();
  assert.equal(peak, MAX_TITLE_REQUESTS);
  while (releases.length > 0) {
    releases.shift()?.();
    await settle();
  }
  assert.equal(peak, MAX_TITLE_REQUESTS);
  assert.equal(documentTitleFor('e'), 'Title e');
});

test('the chat attachment card shows a renamed document under its title and keeps the file name for downloads', () => {
  const attachment = { kind: 'file' as const, name: 'Untitled 2.md', attachmentId: 'att_untitled_2', mimeType: 'text/markdown' };
  const before = renderToStaticMarkup(createElement(TranscriptFileAttachmentLink, { attachment }));
  assert.match(before, /app-attachment-file-name-base">Untitled 2</);
  assert.match(before, /app-attachment-file-name-ext">\.md</);

  rememberDocumentTitle('att_untitled_2', 'xixi xhiqueuqoe');
  const after = renderToStaticMarkup(createElement(TranscriptFileAttachmentLink, { attachment }));
  assert.match(after, /app-attachment-file-name-base">xixi xhiqueuqoe</);
  assert.doesNotMatch(after, /app-attachment-file-name-ext/);
  assert.match(after, /aria-label="Download Untitled 2\.md"/, 'the download keeps the file name');

  rememberDocumentTitle('att_pdf', 'Paper title');
  const pdf = renderToStaticMarkup(createElement(TranscriptFileAttachmentLink, { attachment: { kind: 'file', name: 'paper.pdf', attachmentId: 'att_pdf' } }));
  assert.match(pdf, /app-attachment-file-name-base">paper</, 'other files keep their name');
});
