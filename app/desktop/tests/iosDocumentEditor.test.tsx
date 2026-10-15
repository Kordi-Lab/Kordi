import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRequire } from 'node:module';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { createEditorPage } from '../src/ios-document-editor/editorPage';
import { nativeProviderFactory } from '../src/ios-document-editor/nativeProvider';
import { base64ToBytes, bytesToBase64, NativeBridge, type NativeMessage } from '../src/ios-document-editor/nativeBridge';
import { nativeRequestClient } from '../src/ios-document-editor/nativeDocumentApi';
import { NATIVE_SOCKET_BASE, nativeWebSocketClass, socketPath } from '../src/ios-document-editor/nativeSocket';
import { sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

// lib0 is not a direct dependency; take the copy y-protocols uses.
const fromYProtocols = createRequire(createRequire(import.meta.url).resolve('y-protocols/sync'));
const encoding = fromYProtocols('lib0/encoding') as typeof import('lib0/encoding');
const decoding = fromYProtocols('lib0/decoding') as typeof import('lib0/decoding');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(5);
  }
}

test('requests resolve with the status and body the app answers, and fail on transport errors', async () => {
  const posted: NativeMessage[] = [];
  const bridge = new NativeBridge((message) => posted.push(message));
  const ok = bridge.request('PUT', '/v1/cloud/documents/att_1/content', '{"source":"x"}');
  const failed = bridge.request('GET', '/v1/cloud/documents/att_1');
  assert.deepEqual(posted.map((message) => [message.type, message.method, message.path, message.body]), [
    ['request', 'PUT', '/v1/cloud/documents/att_1/content', '{"source":"x"}'],
    ['request', 'GET', '/v1/cloud/documents/att_1', undefined],
  ]);
  assert.equal(bridge.pendingRequests, 2);
  bridge.reply(String(posted[0].id), { status: 409, body: '{"attachmentId":"att_1"}' });
  bridge.reply(String(posted[1].id), { error: 'Offline' });
  assert.deepEqual(await ok, { status: 409, body: '{"attachmentId":"att_1"}' });
  await assert.rejects(failed, /Offline/);
  assert.equal(bridge.pendingRequests, 0);
});

test('JSON routes surface the server message on errors', async () => {
  const bridge = new NativeBridge((message) => {
    setTimeout(() => bridge.reply(String(message.id), { status: 403, body: '{"message":"You can\'t edit this document."}' }), 0);
  });
  await assert.rejects(nativeRequestClient(bridge).request('/v1/cloud/documents/att_1/collab/ticket', { method: 'POST', body: '{}' }, 'Could not join.'), /can't edit/);
});

test('the socket stand-in opens the app socket by path and carries binary frames both ways', async () => {
  const posted: NativeMessage[] = [];
  const bridge = new NativeBridge((message) => posted.push(message));
  const NativeWebSocket = nativeWebSocketClass(bridge);
  const socket = new NativeWebSocket(`${NATIVE_SOCKET_BASE}/v1/cloud/documents/att_1/collab?ticket=t_1`);
  const events: string[] = [];
  let received: Uint8Array | null = null;
  socket.onopen = () => events.push('open');
  socket.onmessage = (event) => { received = new Uint8Array(event.data); };
  socket.onclose = (event) => events.push(`close ${event.code}`);
  assert.equal(posted[0].type, 'socket.open');
  assert.equal(posted[0].path, '/v1/cloud/documents/att_1/collab?ticket=t_1');
  const id = String(posted[0].socket);

  socket.send(new Uint8Array([9]));
  assert.equal(posted.length, 1, 'nothing is sent before the socket opens');
  bridge.socketEvent(id, 'open', null);
  assert.equal(socket.readyState, socket.OPEN);
  socket.send(new Uint8Array([0, 1, 255]));
  assert.deepEqual(base64ToBytes(String(posted[1].data)), new Uint8Array([0, 1, 255]));
  bridge.socketEvent(id, 'message', bytesToBase64(new Uint8Array([7, 8])));
  assert.deepEqual(received, new Uint8Array([7, 8]));
  bridge.socketEvent(id, 'close', { code: 4403, reason: 'revoked' });
  assert.deepEqual(events, ['open', 'close 4403']);
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(socketPath('/plain'), '/plain');
});

/** A collaboration server behind the app: y-protocols sync over each client's bridge, like the cloud socket. */
function memoryCollabServer() {
  const doc = new Y.Doc();
  const sockets = new Map<string, { bridge: NativeBridge; id: string }>();
  const opened: string[] = [];
  let clients = 0;
  const deliver = (target: { bridge: NativeBridge; id: string }, bytes: Uint8Array) => {
    setTimeout(() => target.bridge.socketEvent(target.id, 'message', bytesToBase64(bytes)), 0);
  };
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    const frame = encoding.toUint8Array(encoder);
    sockets.forEach((socket, key) => { if (key !== origin) deliver(socket, frame); });
  });
  const connect = () => {
    const client = (clients += 1);
    const bridge: NativeBridge = new NativeBridge((message) => {
      const key = `${client}:${String(message.socket)}`;
      if (message.type === 'socket.open') {
        opened.push(String(message.path));
        const socket = { bridge, id: String(message.socket) };
        sockets.set(key, socket);
        setTimeout(() => bridge.socketEvent(socket.id, 'open', null), 0);
        return;
      }
      const socket = sockets.get(key);
      if (!socket || message.type !== 'socket.send') return;
      const decoder = decoding.createDecoder(base64ToBytes(String(message.data)));
      const kind = decoding.readVarUint(decoder);
      if (kind !== 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.readSyncMessage(decoder, encoder, doc, key);
      if (encoding.length(encoder) > 1) deliver(socket, encoding.toUint8Array(encoder));
    });
    return bridge;
  };
  return { doc, opened, connect };
}

test('the Mac sync protocol runs over the app socket: an edit on one side reaches the other', async () => {
  const server = memoryCollabServer();
  const phone = new Y.Doc();
  const mac = new Y.Doc();
  const phoneProvider = nativeProviderFactory(server.connect())(`${NATIVE_SOCKET_BASE}/v1/cloud/documents/att_1`, 'collab', phone, { ticket: 't_phone' });
  // The Mac side here uses its own bridge too; on a real Mac it is a browser WebSocket to the same room.
  const macBridge = server.connect();
  const macProvider = nativeProviderFactory(macBridge)(`${NATIVE_SOCKET_BASE}/v1/cloud/documents/att_1`, 'collab', mac, { ticket: 't_mac' });
  try {
    phoneProvider.connect();
    macProvider.connect();
    await until(() => phoneProvider.synced && macProvider.synced, 'both providers sync');
    assert.ok(server.opened.includes('/v1/cloud/documents/att_1/collab?ticket=t_phone'));
    phone.getText('t').insert(0, 'from the phone');
    await until(() => mac.getText('t').toString() === 'from the phone', 'the Mac sees the phone edit');
    mac.getText('t').insert(0, 'Mac: ');
    await until(() => phone.getText('t').toString() === 'Mac: from the phone', 'the phone sees the Mac edit');
  } finally {
    phoneProvider.destroy();
    macProvider.destroy();
    // Destroying the documents stops their awareness timers.
    phone.destroy();
    mac.destroy();
  }
});

test('the editor page loads through the app, formats from toolbar commands, and saves revisioned Markdown when no room opens', async () => {
  await withJsdomRoot(async () => {
    const view = globalThis.window as unknown as Window & typeof globalThis;
    const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
    // Tiptap's focus command waits a frame.
    Object.assign(globalThis, { requestAnimationFrame: view.requestAnimationFrame.bind(view), cancelAnimationFrame: view.cancelAnimationFrame.bind(view) });
    const document = sampleDocument('member');
    const posted: NativeMessage[] = [];
    const saves: Array<{ baseRevision?: number; source: string }> = [];
    const container = view.document.createElement('main');
    view.document.body.append(container);
    const holder: { receiver: ReturnType<typeof createEditorPage>['receiver'] | null } = { receiver: null };
    const { page, receiver } = createEditorPage((message) => {
      posted.push(message);
      if (message.type !== 'request') return;
      const id = String(message.id);
      const path = String(message.path);
      setTimeout(() => {
        if (message.method === 'GET') holder.receiver?.reply(id, { status: 200, body: JSON.stringify(document) });
        else if (path.endsWith('/collab/ticket')) holder.receiver?.reply(id, { status: 403, body: '{"message":"No room"}' });
        else if (path.endsWith('/content')) {
          saves.push(JSON.parse(String(message.body)));
          holder.receiver?.reply(id, { status: 200, body: JSON.stringify({ ...document, revision: (document.revision ?? 0) + 1 }) });
        }
      }, 0);
    }, container);
    holder.receiver = receiver;

    assert.equal(page.command('bold'), false, 'no editor before start');
    await act(async () => { page.start({ attachmentId: document.attachmentId, user: { name: 'Priya', accountId: 'acct_example_viewer' } }); });
    await waitForReactCondition(() => Boolean(container.querySelector('.ProseMirror h1')), 'the editor loads');
    assert.ok(posted.some((message) => message.type === 'loaded' && message.title === document.title));
    assert.ok(posted.some((message) => message.type === 'request' && String(message.path).endsWith('/collab/ticket')), 'the page asks to join the room');

    const editor = container.querySelector('.ProseMirror') as HTMLElement & { editor?: unknown };
    assert.ok(editor);
    await act(async () => { assert.equal(page.command('block', 'h2'), true); });
    await act(async () => { assert.equal(page.command('bold'), true); });
    const state = [...posted].reverse().find((message) => message.type === 'state');
    assert.ok(state);
    assert.deepEqual(state.formats, ['bold']);
    assert.equal(state.block, 'h2');
    assert.equal(page.command('nope'), false);

    await act(async () => { await page.close(); });
    assert.equal(saves.length, 1, 'closing saves the pending edit');
    assert.equal(saves[0].baseRevision, document.revision);
    assert.match(saves[0].source, /^## Kordi related work/m);
    assert.ok(posted.every((message) => !('token' in message)), 'the page never handles the session token');
  });
});
