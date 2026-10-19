import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, StrictMode } from 'react';

import type { Editor } from '@tiptap/core';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import type { ProviderFactory } from '../src/features/documents/editor/documentRoom';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { createMemoryCollabRoom } from './helpers/memoryCollabRoom';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const ATTACHMENT = 'att_example_doc';
const HOST: DocumentReaderHost = {
  viewer: { accountId: 'acct_example_viewer', displayName: 'Priya', kordiId: null, avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubLayout() {
  const view = globalThis.window as unknown as Window & typeof globalThis;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
  Object.assign(view.HTMLElement.prototype, { getClientRects: () => [] });
}

/** A socket that never opens: the reader stays on revisioned saves. */
function silentRoom(): ProviderFactory {
  const memory = createMemoryCollabRoom();
  return (serverUrl, roomName, doc, params) => {
    const provider = memory.createProvider(serverUrl, roomName, doc, params);
    provider.connect = () => { provider.shouldConnect = true; };
    return provider;
  };
}

for (const room of ['refused', 'silent'] as const) {
  test(`opening a document saves nothing and keeps its content (strict mode, ${room} room)`, async () => {
    await withJsdomRoot(async (mount) => {
      stubLayout();
      const document = sampleDocument('owner');
      let tickets = 0;
      const { api, calls } = createMemoryDocumentApi(document, 5, room === 'silent'
        ? { collabTicket: async () => ({ ticket: `ticket_example_${++tickets}`, url: `/v1/cloud/documents/${ATTACHMENT}/collab` }) }
        : {});
      const view: { editor: Editor | null } = { editor: null };
      const root = await mount(createElement(StrictMode, null, createElement(DocumentReaderHostContext.Provider, { value: HOST }, createElement(DocumentReader, {
        attachmentId: ATTACHMENT,
        api,
        onEditor: (editor: Editor | null) => { view.editor = editor; },
        collabTransport: { createProvider: silentRoom(), timing: { reconnectDelaysMs: [5_000] } },
      }))));
      await waitForReactCondition(() => Boolean(root.querySelector('.ProseMirror h1')), 'the document loads');
      // Longer than the save debounce: an edit reported on open would be saved by now.
      await act(async () => { await sleep(1_000); });
      assert.deepEqual(calls.filter((call) => call.method === 'saveDocumentContent'), [], 'opening is not an edit');
      assert.match(view.editor?.state.doc.textContent ?? '', /Turn-taking in a group/);
      assert.match(root.querySelector('.ProseMirror')?.textContent ?? '', /Turn-taking in a group/);
    });
  });
}
