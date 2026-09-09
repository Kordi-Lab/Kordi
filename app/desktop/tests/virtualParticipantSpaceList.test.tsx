import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSidebarRow } from '../src/pages/sidebar/VirtualChatList';
import { installDom, flush, sidebarTestDom } from './support/virtualSidebarHarness';

let VirtualChatList: typeof import('../src/pages/sidebar/VirtualChatList').VirtualChatList;
let buildChatSidebarRows: typeof import('../src/pages/sidebar/VirtualChatList').buildChatSidebarRows;
let root: Root | null = null;

test.before(async () => {
  installDom();
  ({ VirtualChatList, buildChatSidebarRows } = await import('../src/pages/sidebar/VirtualChatList'));
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  sidebarTestDom.clampScrollToContent = false;
  document.body.innerHTML = '';
});

function channelRows(count: number): ChatSidebarRow[] {
  return buildChatSidebarRows({
    spaces: [{ spaceId: 'group', expanded: true, rootSessionIds: Array.from({ length: count }, (_, index) => `channel-${index}`) }],
    sessions: Array.from({ length: count }, (_, index) => ({ spaceId: 'group', sessionId: `channel-${index}` })),
    collapsedForkParentIds: new Set(),
    includeSpaceRows: true,
  });
}

async function groupListHarness() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = async (rows: ChatSidebarRow[], activeSessionId?: string) => {
    await act(async () => root?.render(<VirtualChatList groupChannels rows={rows} activeSessionId={activeSessionId}
      scrollStyle={{ height: 200 }} renderRow={row => <button>{row.key}</button>}/>));
    await flush();
  };
  return { host, render };
}

test('group collapse retains inert channels and reversing reuses the same channel nodes', async () => {
  const { host, render } = await groupListHarness();
  const expanded = channelRows(3);
  const collapsed = expanded.slice(0, 1);
  await render(collapsed);
  await render(expanded);
  const channel = host.querySelector('[data-chat-sidebar-row="session:channel-0"]');
  assert.ok(channel);
  await render(collapsed);
  const clip = host.querySelector<HTMLElement>('.app-participant-channel-reveal');
  assert.equal(clip?.style.height, '0px');
  assert.equal(clip?.getAttribute('aria-hidden'), 'true');
  assert.ok(clip?.hasAttribute('inert'));
  assert.equal(host.querySelector('[data-chat-sidebar-row="session:channel-0"]'), channel);
  await render(expanded);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  assert.equal(host.querySelector('[data-chat-sidebar-row="session:channel-0"]'), channel);
  assert.equal(clip?.style.height, '138px');
  assert.equal(clip?.getAttribute('aria-hidden'), 'false');
  await render(collapsed);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  assert.equal(host.querySelector('[data-chat-sidebar-row="session:channel-0"]'), null);
});

test('a large group keeps channels virtualized while scrolling inside one space', async () => {
  const { host, render } = await groupListHarness();
  const rows = channelRows(5_000);
  await render(rows);
  assert.ok(host.querySelectorAll('[data-chat-sidebar-row]').length < 30);
  const viewport = host.querySelector<HTMLElement>('[data-virtual-chat-list]')!;
  await act(async () => viewport.scrollTo({ top: 46_064 }));
  await flush();
  assert.ok(host.querySelector('[data-chat-sidebar-row="session:channel-1000"]'));
  assert.equal(host.querySelector('[data-chat-sidebar-row="session:channel-0"]'), null);
  assert.ok(host.querySelectorAll('[data-chat-sidebar-row]').length < 30);
  await render(rows, 'channel-4900');
  assert.ok(viewport.scrollTop > 200_000);
  assert.ok(host.querySelector('[data-chat-sidebar-row="session:channel-4900"]'));
  await act(async () => viewport.scrollTo({ top: 46_064 }));
  await render([...rows], 'channel-4900');
  assert.equal(viewport.scrollTop, 46_064);
});

test('reduced-motion collapse removes retained channels without waiting for the reveal', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
  try {
    const { host, render } = await groupListHarness();
    const rows = channelRows(3);
    await render(rows);
    await render(rows.slice(0, 1));
    await flush();
    assert.equal(host.querySelector('[data-chat-sidebar-row="session:channel-0"]'), null);
  } finally {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else delete (window as Partial<Window>).matchMedia;
  }
});


test('clicking the group header again folds even when its channel is active', async () => {
  const { WorkspaceSidebar } = await import('../src/pages/WorkspaceSidebar');
  const { buildParticipantSpaces } = await import('../src/features/chat/participantSpaces');
  const { conversation, baseSidebarProps } = await import('./helpers/workspaceSidebarParticipantSpacesFixtures');
  const chats = [conversation({
    id: 'session:group:toggle', canonicalSessionId: 'session:group:toggle', name: 'general',
    participants: ['Me', 'Maya', 'Leo'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:maya', name: 'Maya', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'maya' },
      { id: 'human:leo', name: 'Leo', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'leo' },
    ],
  })];
  const spaces = buildParticipantSpaces(chats);
  const selections: string[] = [];
  function Harness() {
    const [activeConvId, setActiveConvId] = useState('');
    return <WorkspaceSidebar {...baseSidebarProps({
      chatConversations: chats, participantSpaces: spaces, contactParticipantSpaces: spaces,
      activeConvId, onSelectChatSession: (id: string) => { selections.push(id); setActiveConvId(id); },
    }) as never}/>;
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness/>));
  await flush();
  const header = host.querySelector<HTMLButtonElement>('[data-testid="participant-space-row"]')!;
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  await act(async () => header.click());
  await flush();
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(selections.length, 1);
  await act(async () => header.click());
  await flush();
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(selections.length, 1, 'folding must not select or reopen the active channel');
  await act(async () => header.click());
  await flush();
  assert.equal(header.getAttribute('aria-expanded'), 'true');
});


test('grouped lists forward the scroll ref and clear it on unmount', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const scrollRef = { current: null as HTMLDivElement | null };
  await act(async () => root?.render(<VirtualChatList groupChannels rows={channelRows(3)}
    scrollRef={scrollRef} scrollStyle={{ height: 200 }} renderRow={row => <div>{row.key}</div>}/>));
  assert.ok(scrollRef.current === host.querySelector('[data-virtual-chat-list]'), 'the caller must receive the grouped viewport');
  await act(async () => root?.unmount());
  root = null;
  assert.equal(scrollRef.current, null);
});

test('selecting a deep channel waits for an opening group to finish measuring', async () => {
  sidebarTestDom.clampScrollToContent = true;
  const { host, render } = await groupListHarness();
  const expanded = channelRows(500);
  await render(expanded.slice(0, 1));
  await render(expanded, 'channel-490');
  await act(async () => sidebarTestDom.notifyMeasuredResize());
  await flush();
  const viewport = host.querySelector<HTMLElement>('[data-virtual-chat-list]')!;
  assert.ok(viewport.scrollTop > 20_000, 'selection must be retried after the opening clip grows');
  assert.ok(host.querySelector('[data-chat-sidebar-row="session:channel-490"]'));
});


test('selecting a channel in a distant group scrolls again after that group mounts', async () => {
  sidebarTestDom.clampScrollToContent = true;
  const { host, render } = await groupListHarness();
  const preceding: ChatSidebarRow[] = Array.from({ length: 150 }, (_, index) => ({
    kind: 'space', key: `space:preceding-${index}`, spaceId: `preceding-${index}`, depth: 0,
  }));
  await render([...preceding, ...channelRows(500)], 'channel-490');
  await act(async () => sidebarTestDom.notifyMeasuredResize());
  await flush();
  const viewport = host.querySelector<HTMLElement>('[data-virtual-chat-list]')!;
  assert.ok(viewport.scrollTop > 30_000);
  assert.ok(host.querySelector('[data-chat-sidebar-row="session:channel-490"]'));
});


test('returning to a channel after selecting a direct chat restores channel navigation', async () => {
  const { host, render } = await groupListHarness();
  const rows = channelRows(500);
  await render(rows, 'channel-490');
  await render(rows, 'direct-chat');
  const viewport = host.querySelector<HTMLElement>('[data-virtual-chat-list]')!;
  await act(async () => viewport.scrollTo({ top: 0 }));
  await render(rows, 'channel-490');
  assert.ok(viewport.scrollTop > 20_000);
});
