import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { CompanionDocument } from '../src/features/documents/companionDocument';
import { DocumentReader } from '../src/features/documents/DocumentReader';
import { cleanDocumentTitle } from '../src/features/documents/documentReaderModel';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import type { DocumentShareApi } from '../src/features/documents/documentShareApi';
import type { DocumentResponse, DocumentUpdatedEvent } from '../src/features/documents/documentShareTypes';
import { notifyDocumentSyncEvents, subscribeDocumentUpdates } from '../src/features/documents/documentSyncEvents';
import { CompanionDocumentPane } from '../src/pages/chatsPage.companionDocument';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const host: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_viewer', displayName: 'Priya', kordiId: '987654321', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: [],
};

/** A new document: no leading heading, so the header shows the file-name title. */
function untitled(overrides: Partial<DocumentResponse> = {}): DocumentResponse {
  const base = sampleDocument('owner');
  return { ...base, title: 'Untitled', fileName: 'Untitled.md', blocks: base.blocks.slice(2), comments: [], reactions: [], ...overrides };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function fire(element: Element, type: string) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function press(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function field(root: ParentNode) {
  return root.querySelector<HTMLInputElement>('input[aria-label="Title"]');
}

/** React falls back to the old IE input events in this JSDOM setup; the fields need them to exist. */
function allowInputEvents() {
  Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
}

async function mountReader(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>, document: DocumentResponse, api: DocumentShareApi) {
  allowInputEvents();
  const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
    createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api })));
  await waitForReactCondition(() => Boolean(root.querySelector('.ProseMirror')), 'the editor loads');
  return root;
}

test('titles are saved with whitespace collapsed, and an empty title is no title', () => {
  assert.equal(cleanDocumentTitle('  Q4 \n plan '), 'Q4 plan');
  assert.equal(cleanDocumentTitle(' \t '), null);
});

test('a double click on the header title renames it in place; Enter saves', async () => {
  await withJsdomRoot(async (mount) => {
    const { api, calls } = createMemoryDocumentApi(untitled());
    const root = await mountReader(mount, untitled(), api);
    const title = root.querySelector('.app-document-header-title');
    assert.equal(title?.textContent, 'Untitled');

    await fire(title as Element, 'dblclick');
    const input = field(root);
    assert.ok(input, 'the title turns into a field');
    assert.ok(input.classList.contains('app-document-header-title'), 'with the title font and place');
    assert.equal(input.value, 'Untitled');
    assert.equal(globalThis.document.activeElement, input);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, 'Untitled'.length, 'the text is selected');

    input.value = '  Field   notes ';
    await press(input, 'Enter');
    await settle();
    assert.equal(field(root), null);
    assert.deepEqual(calls.filter((call) => call.method === 'renameDocument').map((call) => call.args), [['att_example_doc', 'Field notes']]);
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'Field notes');
  });
});

test('Escape cancels, an empty title reverts, and leaving the field saves', async () => {
  await withJsdomRoot(async (mount) => {
    const { api, calls } = createMemoryDocumentApi(untitled());
    const root = await mountReader(mount, untitled(), api);
    const renames = () => calls.filter((call) => call.method === 'renameDocument').length;

    await fire(root.querySelector('.app-document-header-title') as Element, 'dblclick');
    (field(root) as HTMLInputElement).value = 'Discarded';
    await press(field(root) as HTMLInputElement, 'Escape');
    assert.equal(field(root), null);
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'Untitled');

    await fire(root.querySelector('.app-document-header-title') as Element, 'dblclick');
    (field(root) as HTMLInputElement).value = '   ';
    await press(field(root) as HTMLInputElement, 'Enter');
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'Untitled', 'an empty title reverts');
    assert.equal(renames(), 0);

    await fire(root.querySelector('.app-document-header-title') as Element, 'dblclick');
    (field(root) as HTMLInputElement).value = 'Q4 plan';
    await act(async () => { (field(root) as HTMLInputElement).blur(); });
    await settle();
    assert.equal(renames(), 1, 'blur saves');
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'Q4 plan');
  });
});

test('a refused rename restores the title and says so', async () => {
  await withJsdomRoot(async (mount) => {
    const { api } = createMemoryDocumentApi(untitled(), 0, { renameFails: true });
    const root = await mountReader(mount, untitled(), api);
    await fire(root.querySelector('.app-document-header-title') as Element, 'dblclick');
    (field(root) as HTMLInputElement).value = 'Q4 plan';
    await press(field(root) as HTMLInputElement, 'Enter');
    await waitForReactCondition(() => Boolean(root.querySelector('.app-document-error')), 'the error shows');
    assert.equal(root.querySelector('.app-document-header-title')?.textContent, 'Untitled');
    assert.equal(root.querySelector('.app-document-error')?.textContent, 'Could not rename the document.');
  });
});

test('without edit rights, or with a leading heading, a double click does not rename', async () => {
  await withJsdomRoot(async (mount) => {
    const reader = untitled({ viewer: 'member', viewerCan: { share: false, react: true, comment: true, askAgent: true, edit: false } });
    const { api } = createMemoryDocumentApi(reader);
    const root = await mountReader(mount, reader, api);
    await fire(root.querySelector('.app-document-header-title') as Element, 'dblclick');
    assert.equal(field(root), null);
  });
  await withJsdomRoot(async (mount) => {
    const headed = sampleDocument('owner');
    const { api } = createMemoryDocumentApi(headed);
    const root = await mountReader(mount, headed, api);
    assert.equal(root.querySelector('.app-document-header-title'), null, 'the heading in the body is the title');
  });
});

test('document.updated renames reach open readers', () => {
  const seen: DocumentUpdatedEvent[] = [];
  const unsubscribe = subscribeDocumentUpdates('att_title', (event) => seen.push(event));
  notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_title', revision: 2, change: 'title', title: 'Q4 plan' } }]);
  unsubscribe();
  assert.deepEqual(seen, [{ attachmentId: 'att_title', revision: 2, change: 'title' }]);
});

test('a rename made elsewhere reaches the open reader', async () => {
  await withJsdomRoot(async (mount) => {
    const { api } = createMemoryDocumentApi(untitled());
    const root = await mountReader(mount, untitled(), api);
    api.setStored(untitled({ title: 'Q4 plan' }));
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: 'att_example_doc', revision: 3, change: 'title', title: 'Q4 plan' } }]);
    });
    await waitForReactCondition(() => root.querySelector('.app-document-header-title')?.textContent === 'Q4 plan', 'the header shows the new title');
  });
});

/** Two cloud documents by attachment id; renames only where the reader may edit. */
function paneApi(documents: Record<string, DocumentResponse>) {
  const { api, calls } = createMemoryDocumentApi(untitled());
  const served = { ...documents };
  const paneDocuments: DocumentShareApi = {
    ...api,
    getDocument: async (attachmentId) => served[attachmentId],
    renameDocument: async (attachmentId, title) => {
      calls.push({ method: 'renameDocument', args: [attachmentId, title] });
      served[attachmentId] = { ...served[attachmentId], title };
      return served[attachmentId];
    },
  };
  return { api: paneDocuments, calls };
}

function companion(attachmentId: string, name: string): CompanionDocument {
  return { artifact: { id: `attachment:${attachmentId}`, path: name, name, kind: 'document', category: 'artifact', summary: '', attachmentId }, preview: null };
}

function tabs(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('[aria-label="Open documents"] [role="tab"]'));
}

test('a double click on a tab label renames the document; a single click still switches and × still closes', async () => {
  await withJsdomRoot(async (mount) => {
    const mine = untitled({ attachmentId: 'att_mine' });
    const theirs = untitled({ attachmentId: 'att_theirs', title: 'Their notes', fileName: 'Their notes.md', viewer: 'member', viewerCan: { share: false, react: true, comment: true, askAgent: true, edit: false } });
    const { api, calls } = paneApi({ att_mine: mine, att_theirs: theirs });
    const activated: string[] = [];
    const closed: string[] = [];
    const documents = [companion('att_mine', 'Untitled.md'), companion('att_theirs', 'Their notes.md')];
    allowInputEvents();
    const root = await mount(createElement(CompanionDocumentPane, {
      tabs: { documents, activeId: 'attachment:att_mine', activate: (id: string) => activated.push(id), closeTab: (id: string) => closed.push(id) },
      host,
      api,
      onClose: () => undefined,
    }));
    await waitForReactCondition(() => tabs(root).map((entry) => entry.textContent).join() === 'Untitled,Their notes', 'the readers report their titles');

    await fire(tabs(root)[1], 'click');
    assert.deepEqual(activated, ['attachment:att_theirs'], 'a single click switches tabs');
    await fire(tabs(root)[1], 'dblclick');
    assert.equal(field(root), null, 'no rename without edit rights');

    await fire(tabs(root)[0], 'dblclick');
    const input = field(root);
    assert.ok(input?.classList.contains('app-document-tab-title-field'), 'the label turns into a field in the tab');
    assert.equal(input.value, 'Untitled');
    assert.equal(input.selectionEnd, 'Untitled'.length);
    await press(input, 'Escape');
    assert.equal(field(root), null);
    assert.equal(tabs(root)[0].textContent, 'Untitled');

    await fire(tabs(root)[0], 'dblclick');
    (field(root) as HTMLInputElement).value = 'Q4 plan';
    await press(field(root) as HTMLInputElement, 'Enter');
    await waitForReactCondition(() => tabs(root)[0].textContent === 'Q4 plan', 'the tab shows the new title');
    assert.deepEqual(calls.filter((call) => call.method === 'renameDocument').map((call) => call.args), [['att_mine', 'Q4 plan']]);
    assert.equal(root.querySelector('[role="tabpanel"]:not([hidden]) .app-document-header-title')?.textContent, 'Q4 plan', 'the header follows');

    await fire(root.querySelector('[aria-label="Close Q4 plan"]') as Element, 'click');
    assert.deepEqual(closed, ['attachment:att_mine'], 'the × still closes');
  });
});
