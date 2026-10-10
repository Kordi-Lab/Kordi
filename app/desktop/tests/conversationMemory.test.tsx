import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { conversationMemoryScopes, isMemoryForConversation } from '../src/features/memory/conversationMemory';
import { publishMemoryVersion } from '../src/features/memory/memoryAvailability';
import {
  PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  PREVIEW_GROUP_MEMORY_SCOPE_ID,
  createPreviewMemoryClient,
  type MemoryClient,
} from '../src/features/memory/memoryClient';
import type { MemoryLesson } from '../src/features/memory/memoryModel';
import { ChatMemoryTab } from '../src/pages/ChatMemoryTab';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { SessionDestinationTabs } from '../src/pages/chatsPage.destinations';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  // react-dom loads before this DOM exists, so it falls back to the legacy input event polyfill.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
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

function memory(scope: MemoryLesson['scope'], scopeId: string): Pick<MemoryLesson, 'scope' | 'scopeId'> {
  return { scope, scopeId };
}

test('a conversation matches memories saved under its canonical session id', () => {
  const scopes = conversationMemoryScopes({
    sessionIds: ['0acdb239-cf23-46b0-872b-ed92cf6028eb', '0acdb239-cf23-46b0-872b-ed92cf6028eb', undefined],
  });
  assert.deepEqual(scopes, { conversation: ['0acdb239-cf23-46b0-872b-ed92cf6028eb'], group: [], project: [] });
  assert.equal(isMemoryForConversation(memory('conversation', '0acdb239-cf23-46b0-872b-ed92cf6028eb'), scopes), true);
  assert.equal(isMemoryForConversation(memory('conversation', 'another-chat'), scopes), false);
  assert.equal(isMemoryForConversation(memory('conversation', ''), scopes), false);
  // Global memories live only in account settings.
  assert.equal(isMemoryForConversation(memory('global', 'account'), scopes), false);
});

test('a group chat matches the bare group id, the session id, and the space id', () => {
  const sessionId = 'session:group:0b7c-uuid';
  const scopes = conversationMemoryScopes({ sessionIds: [sessionId], participantSpaceId: `group:${sessionId}` });
  assert.deepEqual(scopes.group.sort(), ['0b7c-uuid', `group:${sessionId}`, sessionId].sort());
  assert.equal(isMemoryForConversation(memory('group', '0b7c-uuid'), scopes), true);
  assert.equal(isMemoryForConversation(memory('group', sessionId), scopes), true);
  assert.equal(isMemoryForConversation(memory('group', `group:${sessionId}`), scopes), true);
  assert.equal(isMemoryForConversation(memory('group', 'other-uuid'), scopes), false);
  // The cloud runner saves the group conversation's own memories under the session id.
  assert.equal(isMemoryForConversation(memory('conversation', sessionId), scopes), true);
  assert.equal(isMemoryForConversation(memory('conversation', '0b7c-uuid'), scopes), false);
});

test('a project chat matches its project root and chat project id', () => {
  const scopes = conversationMemoryScopes({ sessionIds: ['chat-1'], projectIds: ['/Users/me/site', 'project-7', null] });
  assert.equal(isMemoryForConversation(memory('project', '/Users/me/site'), scopes), true);
  assert.equal(isMemoryForConversation(memory('project', 'project-7'), scopes), true);
  assert.equal(isMemoryForConversation(memory('project', '/Users/me/other'), scopes), false);
  assert.deepEqual(conversationMemoryScopes({ sessionIds: ['chat-1'] }).project, []);
});

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

async function withRendered(
  element: React.ReactElement,
  run: (host: HTMLElement, window: JSDOM['window']) => Promise<void>,
) {
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

function memoryTab(client: MemoryClient, id: string) {
  return <ChatMemoryTab conversation={{ id, canonicalSessionId: id }} client={client} />;
}

function rowIds(host: ParentNode) {
  return Array.from(host.querySelectorAll('[data-memory-lesson]')).map((row) => row.getAttribute('data-memory-lesson'));
}

test('the Memory tab lists only the chat memories with the sync caption', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  await withRendered(memoryTab(client, PREVIEW_CONVERSATION_MEMORY_SCOPE_ID), async (host) => {
    const section = host.querySelector('[data-conversation-memory]');
    assert.ok(section);
    assert.deepEqual(rowIds(section), ['lesson-1', 'lesson-2']);
    assert.match(section.textContent ?? '', /Synced with taylor@memory\.example/);
    assert.equal(section.querySelector('h2, h3'), null);
    assert.doesNotMatch(section.textContent ?? '', /Forget everything|Let Kordi save memories|British English/);
  });
});

test('a group chat Memory tab lists the group memory', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  await withRendered(memoryTab(client, `session:group:${PREVIEW_GROUP_MEMORY_SCOPE_ID}`), async (host) => {
    assert.deepEqual(rowIds(host), ['lesson-7']);
    assert.match(host.textContent ?? '', /Share screenshots as attachments instead of links\./);
  });
});

test('a chat without memories shows one short line', async () => {
  await withRendered(memoryTab(createPreviewMemoryClient({ latencyMs: 0 }), 'empty-chat'), async (host) => {
    assert.deepEqual(rowIds(host), []);
    assert.match(host.textContent ?? '', /No memories yet\./);
  });
});

test('editing and deleting a chat memory go through the client', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const updates: Array<[string, string]> = [];
  const archived: string[] = [];
  const updateLesson = client.updateLesson.bind(client);
  const archiveLesson = client.archiveLesson.bind(client);
  client.updateLesson = async (lessonId, text) => {
    updates.push([lessonId, text]);
    return updateLesson(lessonId, text);
  };
  client.archiveLesson = async (lessonId) => {
    archived.push(lessonId);
    return archiveLesson(lessonId);
  };
  await withRendered(memoryTab(client, PREVIEW_CONVERSATION_MEMORY_SCOPE_ID), async (host, window) => {
    await click(host.querySelector('[data-memory-lesson="lesson-1"] button[aria-label^="Edit memory"]'), window);
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-memory-lesson="lesson-1"] textarea');
    assert.ok(textarea);
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Keep launch headlines short.');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
      textarea.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
    });
    await click(buttonByText(host, 'Save'), window);
    assert.deepEqual(updates, [['lesson-1', 'Keep launch headlines short.']]);
    assert.match(host.textContent ?? '', /Keep launch headlines short\./);

    await click(host.querySelector('[data-memory-lesson="lesson-2"] button[aria-label^="Delete memory"]'), window);
    assert.match(document.body.textContent ?? '', /Delete this memory\?/);
    const backdrop = document.body.querySelector('[data-app-dialog-backdrop]');
    assert.ok(backdrop);
    await click(buttonByText(backdrop, 'Delete'), window);
    assert.deepEqual(archived, ['lesson-2']);
    assert.deepEqual(rowIds(host), ['lesson-1']);
  });
});

test('the conversation header shows the Memory tab only when the server reports memory', async () => {
  const labels = async () => {
    let result: string[] = [];
    await withRendered(
      <SessionDestinationTabs scope="main" activeDestination="messages" onSelect={() => undefined} />,
      async (host) => {
        result = Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim() ?? '');
      },
    );
    return result;
  };
  publishMemoryVersion(null);
  assert.deepEqual(await labels(), ['Messages', 'Info', 'Artifacts', 'Tasks']);
  publishMemoryVersion(1);
  try {
    assert.deepEqual(await labels(), ['Messages', 'Info', 'Artifacts', 'Tasks', 'Memory']);
  } finally {
    publishMemoryVersion(null);
  }
});

test('the group dialog no longer has a Memory action', async () => {
  const sessionId = `session:group:${PREVIEW_GROUP_MEMORY_SCOPE_ID}`;
  const [space] = buildParticipantSpaces([conversation({
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Design review',
    metadata: { customName: 'Design review', groupSpaceId: sessionId, adminIdentityIds: ['human:me'] },
    participants: ['Me', 'Alice'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
    ],
  })]);
  assert.ok(space);
  const noop = () => undefined;
  await withRendered(
    <GroupDetailsDialog isOpen space={space} contacts={[]} onClose={noop} onRename={noop} onAddMembers={noop} onRemoveMember={noop} onSetAdmin={noop} />,
    async (host) => {
      const labels = Array.from(host.querySelectorAll('.app-group-profile-actions button')).map((button) => button.textContent?.trim());
      assert.ok(labels.includes('Members'));
      assert.equal(labels.includes('Memory'), false);
      assert.ok(host.querySelector('[data-group-member-grid]'));
    },
  );
});
