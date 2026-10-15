import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudConversationLoader } from '../src/features/memory/cloudGroupConversation';
import { conversationMemoryAddTarget } from '../src/features/memory/conversationMemory';
import { MemorySettingsPanel } from '../src/features/memory/MemorySettingsPanel';
import {
  PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  PREVIEW_GROUP_MEMORY_SCOPE_ID,
  createPreviewMemoryClient,
  type MemoryClient,
} from '../src/features/memory/memoryClient';
import { GLOBAL_MEMORY_TARGET, type MemoryAddTarget } from '../src/features/memory/memoryModel';
import { ChatMemoryTab } from '../src/pages/ChatMemoryTab';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  // react-dom loads before this DOM exists, so it falls back to the legacy input event polyfill.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(element: Element | null | undefined, window: JSDOM['window']) {
  assert.ok(element, 'expected an element to click');
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await flush();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

async function type(host: HTMLElement, window: JSDOM['window'], value: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>('[data-memory-new] textarea');
  assert.ok(textarea, 'expected the new memory editor');
  await act(async () => {
    textarea.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    textarea.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
  });
}

async function withRendered(element: React.ReactElement, run: (host: HTMLElement, window: JSDOM['window']) => Promise<void>) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(element); });
    await flush();
    await run(host, installed.dom.window);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

function rowIds(host: ParentNode) {
  return Array.from(host.querySelectorAll('[data-memory-lesson]')).map((row) => row.getAttribute('data-memory-lesson'));
}

/** Records every add the panel sends to the client. */
function recordingClient() {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const added: Array<[MemoryAddTarget, string]> = [];
  const createLesson = client.createLesson.bind(client);
  client.createLesson = async (target, text) => {
    added.push([target, text]);
    return createLesson(target, text);
  };
  return { client, added };
}

const addRow = (host: ParentNode) => host.querySelector('[data-memory-add] button');

test('a chat adds to itself, a group chat to its cloud group, and a project tab to its root', () => {
  assert.deepEqual(
    conversationMemoryAddTarget({ sessionIds: [' chat-1 ', 'chat-1'], cloudConversationIds: [], label: 'Launch copy' }),
    { scope: 'conversation', scopeId: 'chat-1', scopeLabel: 'Launch copy' },
  );
  assert.deepEqual(
    conversationMemoryAddTarget({ sessionIds: ['session:group:local-1'], cloudConversationIds: ['', 'cloud-group-1'], label: '' }),
    { scope: 'group', scopeId: 'cloud-group-1', scopeLabel: null },
  );
  // Without a cloud group id the group has no shared memories to add to.
  assert.equal(conversationMemoryAddTarget({ sessionIds: ['session:group:local-1'], cloudConversationIds: [] }), null);
  assert.deepEqual(
    conversationMemoryAddTarget({ sessionIds: ['chat-1'], cloudConversationIds: [], project: { root: '/projects/site' }, label: 'Site' }),
    { scope: 'project', scopeId: '/projects/site', scopeLabel: 'Site' },
  );
  assert.equal(conversationMemoryAddTarget({ sessionIds: ['chat-1'], cloudConversationIds: [], project: { root: null } }), null);
  assert.equal(conversationMemoryAddTarget({ sessionIds: [], cloudConversationIds: [] }), null);
});

test('settings add a global memory that appears first and names who added it', async () => {
  const { client, added } = recordingClient();
  await withRendered(<MemorySettingsPanel accountId="account-1" client={client} isNativeShell />, async (host, window) => {
    assert.match(host.textContent ?? '', /Global memories · 2/);
    await click(addRow(host), window);
    assert.equal(addRow(host), null);
    assert.equal(host.querySelector('[data-memory-new] textarea')?.getAttribute('aria-label'), 'New memory');

    await click(buttonByText(host, 'Save'), window);
    assert.equal(host.querySelector('[data-memory-new] [role="alert"]')?.textContent, 'Enter a memory.');
    await type(host, window, 'a'.repeat(501));
    assert.match(host.textContent ?? '', /501 \/ 500/);
    await click(buttonByText(host, 'Save'), window);
    assert.equal(host.querySelector('[data-memory-new] [role="alert"]')?.textContent, 'Memories are 500 characters or fewer.');
    assert.deepEqual(added, []);

    await type(host, window, '  Use   metric units. ');
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(added, [[GLOBAL_MEMORY_TARGET, 'Use metric units.']]);
    assert.equal(host.querySelector('[data-memory-new]'), null);
    assert.ok(addRow(host));
    assert.deepEqual(rowIds(host), ['lesson-added-1', 'lesson-8', 'lesson-9']);
    assert.match(host.querySelector('[data-memory-lesson="lesson-added-1"]')?.textContent ?? '', /Use metric units\.Added by you · Today/);
    assert.match(host.textContent ?? '', /Global memories · 3/);
  });
});

test('cancel closes the new memory editor without saving', async () => {
  const { client, added } = recordingClient();
  await withRendered(<MemorySettingsPanel accountId="account-1" client={client} isNativeShell />, async (host, window) => {
    await click(addRow(host), window);
    await type(host, window, 'Draft.');
    await click(buttonByText(host, 'Cancel'), window);
    assert.equal(host.querySelector('[data-memory-new]'), null);
    assert.deepEqual(added, []);
  });
});

test('with memory off there is no add row', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  await client.updateSettings({ lessonsEnabled: false });
  await withRendered(<MemorySettingsPanel accountId="account-1" client={client} isNativeShell />, async (host) => {
    assert.match(host.textContent ?? '', /Memory is off\./);
    assert.equal(addRow(host), null);
    assert.deepEqual(rowIds(host), ['lesson-8', 'lesson-9']);
  });
  await withRendered(
    <ChatMemoryTab conversation={{ id: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID }} client={client} />,
    async (host) => {
      assert.deepEqual(rowIds(host), ['lesson-1', 'lesson-2']);
      assert.equal(addRow(host), null);
    },
  );
});

test('a chat Memory tab adds to the chat it is opened from', async () => {
  const { client, added } = recordingClient();
  const tab = (
    <ChatMemoryTab
      conversation={{ id: 'local-id', canonicalSessionId: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID, name: 'Launch copy with Priya' }}
      client={client}
    />
  );
  await withRendered(tab, async (host, window) => {
    await click(addRow(host), window);
    await type(host, window, 'Ship the launch post on Tuesday.');
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(added, [[
      { scope: 'conversation', scopeId: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID, scopeLabel: 'Launch copy with Priya' },
      'Ship the launch post on Tuesday.',
    ]]);
    assert.deepEqual(rowIds(host), ['lesson-added-1', 'lesson-1', 'lesson-2']);
  });
});

test('a group Memory tab adds a shared memory under the cloud group id', async () => {
  const { client, added } = recordingClient();
  const localSessionId = 'session:group:a47e1bcf-4911-5988-9150-1c106bd49848';
  const load: CloudConversationLoader = async () => [{ id: PREVIEW_GROUP_MEMORY_SCOPE_ID, kind: 'group', legacy_session_id: localSessionId }];
  const tab = (
    <ChatMemoryTab
      conversation={{ id: localSessionId, canonicalSessionId: localSessionId, name: 'Design review' }}
      client={client}
      loadCloudConversations={load}
    />
  );
  await withRendered(tab, async (host, window) => {
    await click(addRow(host), window);
    await type(host, window, 'Review designs on Thursdays.');
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(added.map(([target]) => target), [{ scope: 'group', scopeId: PREVIEW_GROUP_MEMORY_SCOPE_ID, scopeLabel: 'Design review' }]);
    assert.equal(rowIds(host)[0], 'lesson-added-1');
  });
});

test('a project Memory tab adds to the project root', async () => {
  const { client, added } = recordingClient();
  const tab = (
    <ChatMemoryTab
      conversation={{ id: 'project-session-1' }}
      projectRoot="proj-launch-site"
      project={{ name: 'Launch site', root: 'proj-launch-site' }}
      client={client}
    />
  );
  await withRendered(tab, async (host, window) => {
    assert.deepEqual(rowIds(host), ['lesson-5']);
    await click(addRow(host), window);
    await type(host, window, 'Run the image check before each build.');
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(added.map(([target]) => target), [{ scope: 'project', scopeId: 'proj-launch-site', scopeLabel: 'Launch site' }]);
    assert.deepEqual(rowIds(host), ['lesson-added-1', 'lesson-5']);
  });
});

test('a failed add keeps the draft and shows the error inline', async () => {
  const client: MemoryClient = createPreviewMemoryClient({ latencyMs: 0 });
  client.createLesson = async () => { throw new Error('Memories cannot include health details.'); };
  await withRendered(<ChatMemoryTab conversation={{ id: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID }} client={client} />, async (host, window) => {
    await click(addRow(host), window);
    await type(host, window, 'I was diagnosed with a cold.');
    await click(buttonByText(host, 'Save'), window);
    assert.equal(host.querySelector('[data-memory-new] [role="alert"]')?.textContent, 'Memories cannot include health details.');
    assert.equal(host.querySelector<HTMLTextAreaElement>('[data-memory-new] textarea')?.value, 'I was diagnosed with a cold.');
    assert.deepEqual(rowIds(host), ['lesson-1', 'lesson-2']);
  });
});

test('adding text the scope already has shows the memory once', async () => {
  const { client } = recordingClient();
  await withRendered(<MemorySettingsPanel accountId="account-1" client={client} isNativeShell />, async (host, window) => {
    await click(addRow(host), window);
    await type(host, window, 'Answer in British English and keep replies short unless I ask for more detail.');
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(rowIds(host), ['lesson-8', 'lesson-9']);
  });
});
