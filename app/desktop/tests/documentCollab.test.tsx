import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import * as Y from 'yjs';

import type { Editor } from '@tiptap/core';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { presenceColor } from '../src/features/documents/documentPresence';
import { notifyDocumentSyncEvents } from '../src/features/documents/documentSyncEvents';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { useCloudDocumentEdits } from '../src/features/documents/useCloudDocumentEdits';
import DocumentEditor from '../src/features/documents/editor/DocumentEditor';
import { DocumentRoom, type CollabUser } from '../src/features/documents/editor/documentRoom';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { createMemoryCollabRoom } from './helpers/memoryCollabRoom';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const ATTACHMENT = 'att_example_doc';
const SOCKET_PATH = `/v1/cloud/documents/${ATTACHMENT}/collab`;
const FAST = { reconnectDelaysMs: [10, 20], snapshotDelayMs: 20 };
const PRIYA: CollabUser = { name: 'Priya', color: presenceColor('acct_example_viewer'), accountId: 'acct_example_viewer' };
const ALEX: CollabUser = { name: 'Alex Morgan', color: presenceColor('acct_example_alex'), accountId: 'acct_example_alex' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(5);
  }
}

function ticketing() {
  let issued = 0;
  return async () => ({ ticket: `ticket_example_${++issued}`, url: SOCKET_PATH });
}

function roomFor(api: ReturnType<typeof createMemoryDocumentApi>['api'], room: ReturnType<typeof createMemoryCollabRoom>, user: CollabUser, clientId: number, markdown: string, timing = FAST) {
  const created = new DocumentRoom({ api, attachmentId: ATTACHMENT, user, createProvider: room.createProvider, markdown: () => markdown, timing });
  created.ydoc.clientID = clientId;
  return created;
}

function typeInto(doc: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('document').push([paragraph]);
}

const snapshots = (calls: ReturnType<typeof createMemoryDocumentApi>['calls']) => calls
  .filter((call) => call.method === 'saveDocumentContent')
  .map((call) => call.args[1] as { mode?: string; source: string; baseRevision?: number });

test('a ticket is requested and the socket opens with it; the awareness carries the viewer', async () => {
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: ticketing() });
  const memory = createMemoryCollabRoom();
  const room = roomFor(api, memory, PRIYA, 7, 'Priya');
  room.start();
  try {
    await until(() => room.status === 'connected', 'the room connects');
    assert.deepEqual(calls.filter((call) => call.method === 'requestCollabTicket').map((call) => call.args[0]), [ATTACHMENT]);
    assert.deepEqual(memory.opened, [{ serverUrl: `wss://kordi.example/v1/cloud/documents/${ATTACHMENT}`, roomName: 'collab', ticket: 'ticket_example_1' }]);
    assert.deepEqual(room.provider!.awareness.getLocalState(), { user: PRIYA });
    assert.match(PRIYA.color, /^#[0-9a-f]{6}$/);
    assert.equal(presenceColor('acct_example_viewer'), PRIYA.color, 'the color is stable per account');
  } finally {
    room.destroy();
  }
});

test('every reconnect asks for a fresh ticket; the used one is never reused', async () => {
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: ticketing() });
  const memory = createMemoryCollabRoom();
  const room = roomFor(api, memory, PRIYA, 7, 'Priya');
  room.start();
  try {
    await until(() => room.status === 'connected', 'the room connects');
    memory.providers[0].close(1006);
    assert.equal(room.status, 'offline');
    assert.equal(room.provider!.shouldConnect, false, 'the provider does not reconnect with the used ticket');
    await until(() => room.status === 'connected', 'the room reconnects');
    assert.equal(calls.filter((call) => call.method === 'requestCollabTicket').length, 2);
    assert.deepEqual(memory.opened.map((entry) => entry.ticket), ['ticket_example_1', 'ticket_example_2']);
    assert.equal(memory.providers.length, 1, 'one provider, new ticket in its params');
  } finally {
    room.destroy();
  }
});

test('only the connected editor with the smallest client id writes snapshots', async () => {
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: ticketing() });
  const memory = createMemoryCollabRoom();
  const first = roomFor(api, memory, PRIYA, 3, '# From the writer');
  const second = roomFor(api, memory, ALEX, 9, '# From the other editor');
  first.start();
  second.start();
  try {
    await until(() => first.status === 'connected' && second.status === 'connected', 'both connect');
    await until(() => first.peers().length === 1 && second.peers().length === 1, 'each sees the other');
    assert.deepEqual(second.peers().map((peer) => ({ name: peer.name, accountId: peer.accountId, color: peer.color })), [{ name: 'Priya', accountId: PRIYA.accountId, color: PRIYA.color }]);
    assert.equal(first.isSnapshotWriter(), true);
    assert.equal(second.isSnapshotWriter(), false);
    typeInto(second.ydoc, 'Typed by the other editor');
    await until(() => snapshots(calls).length === 1, 'the writer saves a snapshot');
    await sleep(60);
    const saved = snapshots(calls);
    assert.equal(saved.length, 1, 'one snapshot for one burst of updates');
    assert.deepEqual(saved[0], { mode: 'snapshot', source: '# From the writer' }, 'written by the smallest client id, with no base revision');
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('the writer saves a snapshot when its connection closes; the others do not', async () => {
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: ticketing() });
  const memory = createMemoryCollabRoom();
  const slow = { reconnectDelaysMs: [5_000], snapshotDelayMs: 5_000 };
  const first = roomFor(api, memory, PRIYA, 3, '# Writer', slow);
  const second = roomFor(api, memory, ALEX, 9, '# Other', slow);
  first.start();
  second.start();
  try {
    await until(() => first.status === 'connected' && second.status === 'connected' && first.peers().length === 1, 'both connect');
    typeInto(first.ydoc, 'Unsaved edit');
    memory.providers[1].close(1006);
    await sleep(20);
    assert.equal(snapshots(calls).length, 0, 'a closing non-writer writes nothing');
    memory.providers[0].close(1006);
    await until(() => snapshots(calls).length === 1, 'the writer snapshots on disconnect');
    assert.deepEqual(snapshots(calls)[0], { mode: 'snapshot', source: '# Writer' });
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('a refused ticket leaves the room offline and it rejoins when tickets come back', async () => {
  let available = false;
  const issue = ticketing();
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, {
    collabTicket: async () => {
      if (!available) throw new Error('Collaboration is not available.');
      return issue();
    },
  });
  const memory = createMemoryCollabRoom();
  const room = roomFor(api, memory, PRIYA, 7, 'Priya');
  room.start();
  try {
    await until(() => calls.filter((call) => call.method === 'requestCollabTicket').length >= 2, 'it retries');
    assert.equal(room.status, 'offline');
    assert.equal(memory.opened.length, 0);
    available = true;
    await until(() => room.status === 'connected', 'it rejoins');
    assert.deepEqual(memory.opened.map((entry) => entry.ticket), ['ticket_example_1']);
  } finally {
    room.destroy();
  }
});

function editorElement(api: ReturnType<typeof createMemoryDocumentApi>['api'], memory: ReturnType<typeof createMemoryCollabRoom>, user: CollabUser, document: DocumentResponse, onEditor: (editor: Editor | null) => void) {
  return createElement(DocumentEditor, {
    key: user.accountId,
    collab: { api, attachmentId: ATTACHMENT, user },
    createProvider: memory.createProvider,
    roomTiming: FAST,
    blocks: document.blocks.map((block) => ({ id: block.id, source: block.source })),
    revisionKey: '3',
    editable: true,
    canComment: false,
    canReact: false,
    reactions: [],
    comments: [],
    composingBlock: null,
    renderAnnotations: () => null,
    onChange: () => undefined,
    onComment: () => undefined,
    onReact: () => undefined,
    onEditor,
  });
}

function stubLayout() {
  const view = globalThis.window as unknown as Window & typeof globalThis;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
  Object.assign(view.HTMLElement.prototype, { getClientRects: () => [] });
}

test('the init grant seeds an empty room once from the Markdown; initialize false waits for the room', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    let grants = 0;
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document, 0, {
      collabTicket: ticketing(),
      collabInit: async () => ({ initialize: grants++ === 0, revision: 3 }),
    });
    const memory = createMemoryCollabRoom();
    const editors: { first: Editor | null; second: Editor | null } = { first: null, second: null };
    await mount(createElement('div', null,
      editorElement(api, memory, PRIYA, document, (editor) => { editors.first = editor; }),
      editorElement(api, memory, ALEX, document, (editor) => { editors.second = editor; }),
    ));
    const text = (editor: Editor | null) => editor?.state.doc.textContent ?? '';
    await waitForReactCondition(() => memory.providers.length === 2 && memory.providers.every((provider) => provider.synced), 'both editors join');
    await waitForReactCondition(() => memory.fragment().length > 0, 'the room is seeded');
    await waitForReactCondition(() => text(editors.first).includes('Turn-taking') && text(editors.second).includes('Turn-taking'), 'both editors show the seeded room');
    await act(async () => { await sleep(50); });
    assert.equal(grants >= 1, true);
    assert.equal(calls.filter((call) => call.method === 'initCollab').length, grants);
    assert.equal(memory.fragment().length, document.blocks.length, 'seeded once: one copy of every block');
    assert.equal(text(editors.first), text(editors.second));
    const ids = (editor: Editor | null) => { const found: string[] = []; editor?.state.doc.forEach((node) => found.push(String(node.attrs.id))); return found; };
    assert.deepEqual(ids(editors.first), ids(editors.second), 'block ids travel with the room');
    assert.ok(ids(editors.first).every((id) => /^k:[a-z0-9]{8}$/.test(id)));
  });
});

test('without the init grant an empty room stays empty until someone seeds it', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document, 0, { collabTicket: ticketing(), collabInit: async () => ({ initialize: false }) });
    const memory = createMemoryCollabRoom();
    const view: { editor: Editor | null } = { editor: null };
    await mount(editorElement(api, memory, PRIYA, document, (editor) => { view.editor = editor; }));
    await waitForReactCondition(() => calls.some((call) => call.method === 'initCollab'), 'it asks for the grant');
    await act(async () => { await sleep(50); });
    assert.equal(memory.fragment().length, 0, 'it does not seed');
    assert.equal(snapshots(calls).length, 0);
    await act(async () => { typeInto(memory.server, 'Seeded elsewhere'); await sleep(20); });
    await waitForReactCondition(() => (view.editor?.state.doc.textContent ?? '').includes('Seeded elsewhere'), 'the room content arrives');
  });
});

const HOST: DocumentReaderHost = {
  viewer: { accountId: PRIYA.accountId, displayName: PRIYA.name, kordiId: '987654321', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: [],
};

test('the reader joins as the viewer and shows the other editors in the header', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    const document = sampleDocument('owner');
    const { api } = createMemoryDocumentApi(document, 0, { collabTicket: ticketing(), collabInit: async () => ({ initialize: true }) });
    const memory = createMemoryCollabRoom();
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: HOST }, createElement(DocumentReader, {
      attachmentId: ATTACHMENT,
      initialDocument: document,
      api,
      collabTransport: { createProvider: memory.createProvider, timing: FAST },
    })));
    await waitForReactCondition(() => memory.providers.length === 1 && memory.providers[0].synced, 'the reader joins the room');
    assert.deepEqual(memory.providers[0].awareness.getLocalState()?.user, PRIYA);
    const other = roomFor(api, memory, ALEX, 1, '# Other');
    await act(async () => { other.start(); });
    try {
      await waitForReactCondition(() => Boolean(root.querySelector('.app-document-presence-avatar')), 'the header shows the other editor');
      const avatar = root.querySelector<HTMLElement>('.app-document-presence-avatar')!;
      assert.equal(avatar.textContent, 'AM');
      assert.equal(avatar.style.backgroundColor !== '', true);
      assert.match(root.querySelector('.app-document-presence')!.getAttribute('aria-label') ?? '', /Alex Morgan/);
    } finally {
      await act(async () => { other.destroy(); });
    }
    await waitForReactCondition(() => !root.querySelector('.app-document-presence-avatar'), 'the avatar leaves with the editor');
  });
});

test('a refused ticket keeps the reader on revisioned saves', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    const document = sampleDocument('owner');
    const { api, calls } = createMemoryDocumentApi(document);
    const view: { editor: Editor | null } = { editor: null };
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: HOST }, createElement(DocumentReader, {
      attachmentId: ATTACHMENT,
      initialDocument: document,
      api,
      onEditor: (editor: Editor | null) => { view.editor = editor; },
    })));
    await waitForReactCondition(() => Boolean(view.editor && root.querySelector('.ProseMirror > h1')), 'the editor loads');
    await waitForReactCondition(() => calls.some((call) => call.method === 'requestCollabTicket'), 'it asks for a ticket');
    await act(async () => { view.editor!.chain().setTextSelection(view.editor!.state.doc.content.size - 1).insertContent(' More.').run(); });
    await act(async () => { await sleep(900); });
    const saved = snapshots(calls);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].baseRevision, 3, 'a revisioned save');
    assert.equal(saved[0].mode, undefined);
  });
});

test('while the room is connected, document.updated refreshes annotations but not the content', async () => {
  await withJsdomRoot(async (mount) => {
    const document = sampleDocument('owner');
    const { api } = createMemoryDocumentApi(document);
    api.setStored({ ...document, revision: 9 });
    const view = { documents: 0, annotations: 0 };
    function Harness() {
      useCloudDocumentEdits({
        api,
        document,
        enabled: true,
        collaborating: true,
        onDocument: () => { view.documents += 1; },
        onAnnotations: () => { view.annotations += 1; },
      });
      return null;
    }
    await mount(createElement(Harness));
    await act(async () => {
      notifyDocumentSyncEvents([{ eventType: 'document.updated', payload: { attachmentId: ATTACHMENT, revision: 9, change: 'content' } }]);
      await sleep(400);
    });
    assert.equal(view.documents, 0, 'the room carries the content');
    assert.equal(view.annotations, 1);
  });
});

test('a stale room takes the snapshot version of the blocks that differ, by id, and keeps room-only blocks', async () => {
  await withJsdomRoot(async () => {
    const { Editor: HeadlessEditor } = await import('@tiptap/core');
    const { documentEditorExtensions } = await import('../src/features/documents/editor/documentEditorExtensions');
    const { parseBlocks, serializeBlocks } = await import('../src/features/documents/editor/documentBlockIds');
    const { reconciledContent } = await import('../src/features/documents/editor/documentEditorSync');
    const editor = new HeadlessEditor({ extensions: documentEditorExtensions() });
    try {
      const room = parseBlocks(editor.markdown!, [
        { id: 'k:aaaaaaaa', source: '# Title' },
        { id: 'k:bbbbbbbb', source: 'Room text.' },
        { id: 'k:dddddddd', source: 'Only in the room.' },
      ]).doc;
      const snapshot = [
        { id: 'k:aaaaaaaa', source: '# Title' },
        { id: 'k:bbbbbbbb', source: 'Saved outside the room.' },
        { id: 'k:cccccccc', source: 'New outside the room.' },
      ];
      const result = serializeBlocks(editor.markdown!, reconciledContent(editor, room, snapshot));
      assert.deepEqual(result.map((block) => [block.id, block.source.replace(/\n<!-- k:[a-z0-9]+ -->$/, '')]), [
        ['k:aaaaaaaa', '# Title'],
        ['k:bbbbbbbb', 'Saved outside the room.'],
        ['k:cccccccc', 'New outside the room.'],
        ['k:dddddddd', 'Only in the room.'],
      ]);
    } finally {
      editor.destroy();
    }
  });
});

test('a stale room keeps its content unchanged when the snapshot is empty', async () => {
  await withJsdomRoot(async () => {
    const { Editor: HeadlessEditor } = await import('@tiptap/core');
    const { documentEditorExtensions } = await import('../src/features/documents/editor/documentEditorExtensions');
    const { parseBlocks } = await import('../src/features/documents/editor/documentBlockIds');
    const { reconciledContent } = await import('../src/features/documents/editor/documentEditorSync');
    const editor = new HeadlessEditor({ extensions: documentEditorExtensions() });
    try {
      const room = parseBlocks(editor.markdown!, [
        { id: 'k:aaaaaaaa', source: '# Title' },
        { id: 'k:bbbbbbbb', source: 'Room text.' },
      ]).doc;
      assert.deepEqual(reconciledContent(editor, room, []), room, 'no blank paragraph is added');
    } finally {
      editor.destroy();
    }
  });
});
