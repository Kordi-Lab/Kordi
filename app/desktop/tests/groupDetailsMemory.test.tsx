import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { groupMemoryScopeIds, isMemoryForGroup } from '../src/features/memory/groupMemory';
import {
  PREVIEW_GROUP_MEMORY_SCOPE_ID,
  createPreviewMemoryClient,
  type MemoryClient,
} from '../src/features/memory/memoryClient';
import type { MemoryLesson } from '../src/features/memory/memoryModel';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
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

function groupSpace(groupUuid: string) {
  const sessionId = `session:group:${groupUuid}`;
  const [space] = buildParticipantSpaces([conversation({
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Design review',
    metadata: { customName: 'Design review', groupSpaceId: sessionId, adminIdentityIds: ['human:me'] },
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })]);
  assert.ok(space);
  assert.equal(space.kind, 'group');
  return space;
}

function memory(scopeId: string, scope: MemoryLesson['scope'] = 'group'): Pick<MemoryLesson, 'scope' | 'scopeId'> {
  return { scope, scopeId };
}

test('group memory scope ids accept the bare uuid, the space id, and the session id', () => {
  const space = groupSpace('0b7c-uuid');
  const scopeIds = groupMemoryScopeIds(space);
  assert.ok(scopeIds.includes('0b7c-uuid'));
  assert.ok(scopeIds.includes('session:group:0b7c-uuid'));
  assert.ok(scopeIds.includes(space.id));
  assert.equal(isMemoryForGroup(memory('0b7c-uuid'), scopeIds), true);
  assert.equal(isMemoryForGroup(memory('session:group:0b7c-uuid'), scopeIds), true);
  assert.equal(isMemoryForGroup(memory(space.id), scopeIds), true);
  assert.equal(isMemoryForGroup(memory('other-uuid'), scopeIds), false);
  assert.equal(isMemoryForGroup(memory(''), scopeIds), false);
  // A conversation memory never belongs to a group, even with a matching id.
  assert.equal(isMemoryForGroup(memory('0b7c-uuid', 'conversation'), scopeIds), false);
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

async function withGroupDialog(
  memoryClient: MemoryClient | null,
  run: (host: HTMLElement, window: JSDOM['window']) => Promise<void>,
  groupUuid = PREVIEW_GROUP_MEMORY_SCOPE_ID,
) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => undefined;
  const render = (isOpen: boolean) => root.render(
    <GroupDetailsDialog
      isOpen={isOpen}
      space={groupSpace(groupUuid)}
      contacts={[]}
      onClose={noop}
      onRename={noop}
      onAddMembers={noop}
      onRemoveMember={noop}
      onSetAdmin={noop}
      memoryClient={memoryClient}
    />,
  );
  try {
    await act(async () => { render(true); });
    await flush();
    await run(host, installed.dom.window);
    // Closing and reopening always starts on the members view.
    await act(async () => { render(false); });
    await act(async () => { render(true); });
    await flush();
    assert.ok(host.querySelector('[data-group-member-grid]'));
    assert.equal(host.querySelector('[data-group-memory]'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

function headerAction(host: ParentNode, label: string) {
  return host.querySelector('.app-group-profile-actions')
    ?.querySelectorAll<HTMLButtonElement>('button')
    .values()
    .find((button) => button.textContent?.trim() === label);
}

async function openMemoryView(host: HTMLElement, window: JSDOM['window']) {
  await click(headerAction(host, 'Memory'), window);
  const section = host.querySelector('[data-group-memory]');
  assert.ok(section, 'expected the memory view');
  return section;
}

test('the Memory action switches the group dialog to the memory view and Members switches back', async () => {
  await withGroupDialog(createPreviewMemoryClient({ latencyMs: 0 }), async (host, window) => {
    const labels = Array.from(host.querySelectorAll('.app-group-profile-actions button')).map((button) => button.textContent?.trim());
    assert.deepEqual(labels.slice(0, 2), ['Members', 'Memory']);
    assert.equal(headerAction(host, 'Members')?.getAttribute('aria-pressed'), 'true');
    assert.equal(headerAction(host, 'Memory')?.getAttribute('aria-pressed'), 'false');
    assert.ok(host.querySelector('[data-group-member-grid]'));
    assert.equal(host.querySelector('[data-group-memory]'), null);

    const section = await openMemoryView(host, window);
    assert.equal(headerAction(host, 'Memory')?.getAttribute('aria-pressed'), 'true');
    assert.equal(headerAction(host, 'Members')?.getAttribute('aria-pressed'), 'false');
    assert.equal(section.querySelector('h3'), null);
    assert.match(section.textContent ?? '', /What Kordi remembers in this group\. Only you can see your own memories\./);
    assert.deepEqual(
      Array.from(section.querySelectorAll('[data-memory-lesson]')).map((row) => row.getAttribute('data-memory-lesson')),
      ['lesson-7'],
    );
    assert.match(section.textContent ?? '', /Share screenshots as attachments instead of links\./);
    assert.doesNotMatch(section.textContent ?? '', /Forget everything|Replay state|Let Kordi save memories/);
    assert.equal(host.querySelector('[data-group-member-grid]'), null);
    assert.equal(host.querySelector('input[type="search"]'), null);
    assert.equal(host.querySelector('section[aria-label="Group settings"]'), null);

    await click(headerAction(host, 'Members'), window);
    assert.ok(host.querySelector('[data-group-member-grid]'));
    assert.ok(host.querySelector('section[aria-label="Group settings"]'));
    assert.equal(host.querySelector('[data-group-memory]'), null);
    assert.equal(document.activeElement, host.querySelector('input[type="search"]'));
  });
});

test('Add people and Manage leave the memory view for the members view', async () => {
  await withGroupDialog(createPreviewMemoryClient({ latencyMs: 0 }), async (host, window) => {
    await openMemoryView(host, window);
    await click(headerAction(host, 'Add people'), window);
    assert.equal(host.querySelector('[data-group-memory]'), null);
    assert.ok(host.querySelector('[data-group-member-grid]'));
    assert.match(host.textContent ?? '', /Existing contacts/);

    await openMemoryView(host, window);
    await click(headerAction(host, 'Manage'), window);
    assert.equal(host.querySelector('[data-group-memory]'), null);
    assert.ok(host.querySelector('form.app-group-management-name-form input'));
  });
});

test('a group without memories shows the empty state', async () => {
  await withGroupDialog(createPreviewMemoryClient({ latencyMs: 0 }), async (host, window) => {
    const section = await openMemoryView(host, window);
    assert.equal(section.querySelectorAll('[data-memory-lesson]').length, 0);
    assert.match(section.textContent ?? '', /No memories for this group yet\./);
  }, 'another-group-uuid');
});

test('editing a group memory saves through the client', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const updates: Array<[string, string]> = [];
  const updateLesson = client.updateLesson.bind(client);
  client.updateLesson = async (lessonId, text) => {
    updates.push([lessonId, text]);
    return updateLesson(lessonId, text);
  };
  await withGroupDialog(client, async (host, window) => {
    await openMemoryView(host, window);
    await click(host.querySelector('[data-memory-lesson="lesson-7"] button[aria-label^="Edit memory"]'), window);
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-memory-lesson="lesson-7"] textarea');
    assert.ok(textarea);
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Attach screenshots instead of sharing folder links.');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
      textarea.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
    });
    const section = host.querySelector('[data-group-memory]');
    assert.ok(section);
    await click(buttonByText(section, 'Save'), window);
    assert.deepEqual(updates, [['lesson-7', 'Attach screenshots instead of sharing folder links.']]);
    assert.equal(host.querySelector('[data-group-memory] textarea'), null);
    assert.match(section.textContent ?? '', /Attach screenshots instead of sharing folder links\./);
  });
});

test('deleting a group memory asks first, then archives it through the client', async () => {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const archived: string[] = [];
  const archiveLesson = client.archiveLesson.bind(client);
  client.archiveLesson = async (lessonId) => {
    archived.push(lessonId);
    return archiveLesson(lessonId);
  };
  await withGroupDialog(client, async (host, window) => {
    await openMemoryView(host, window);
    await click(host.querySelector('[data-memory-lesson="lesson-7"] button[aria-label^="Delete memory"]'), window);
    assert.match(document.body.textContent ?? '', /Delete this memory\?/);
    assert.deepEqual(archived, []);
    const backdrop = document.body.querySelector('[data-app-dialog-backdrop]');
    assert.ok(backdrop);
    await click(buttonByText(backdrop, 'Delete'), window);
    assert.deepEqual(archived, ['lesson-7']);
    assert.equal(host.querySelector('[data-memory-lesson="lesson-7"]'), null);
    assert.match(host.querySelector('[data-group-memory]')?.textContent ?? '', /No memories for this group yet\./);
    assert.doesNotMatch(document.body.textContent ?? '', /Delete this memory\?/);
    assert.equal((await client.listLessons()).some((lesson) => lesson.lessonId === 'lesson-7'), false);
  });
});

test('the Memory action and view are hidden without a memory client', async () => {
  await withGroupDialog(null, async (host) => {
    assert.ok(host.querySelector('section[aria-label="Group members"]'));
    assert.equal(headerAction(host, 'Memory'), undefined);
    assert.equal(headerAction(host, 'Members')?.hasAttribute('aria-pressed'), false);
    assert.equal(host.querySelector('[data-group-memory]'), null);
    assert.doesNotMatch(host.textContent ?? '', /What Kordi remembers in this group/);
  });
});
