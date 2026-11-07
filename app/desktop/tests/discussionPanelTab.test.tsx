import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { act, createElement, useCallback, useLayoutEffect, useRef } from 'react';

import { useCompanionDocument } from '../src/features/documents/useCompanionDocument';
import type { Message } from '../src/kordi-app/types';
import { CompanionToolbar } from '../src/pages/chatsPage.companionToolbar';
import { useChatCompanionLayout } from '../src/pages/useChatCompanionLayout';
import { useChatThreadSelection } from '../src/pages/useChatThreadSelection';
import { useCompanionPaneContent } from '../src/pages/useCompanionPaneContent';
import { companionToolbarView, companionViewTabId, useCompanionPaneTabs } from '../src/pages/useCompanionPaneTabs';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const message = (id: string, text: string): Message => ({ id, sender: 'Maya Chen', text, time: '20:23', isOwnMessage: false } as Message);

/** The ChatsPage wiring: opening a discussion selects its tab in the side panel. */
function useDiscussionHarness(onClosed: () => void) {
  const reveal = useRef(() => {});
  const onOpen = useCallback(() => reveal.current(), []);
  const thread = useChatThreadSelection({ conversationId: 'design-review', sessionId: 'design-review', isNativeShell: false, onOpen });
  const documents = useCompanionDocument('design-review');
  const tabs = useCompanionPaneTabs('design-review', documents, { name: 'Onboarding copy' }, Boolean(thread.activeThreadRootId));
  const layout = useChatCompanionLayout({ pageConversationId: 'design-review', activePaneKind: 'human', companionConversation: null, hasOverview: tabs.view !== 'chat' });
  useLayoutEffect(() => {
    reveal.current = () => { tabs.setView('discussion'); layout.placeCompanion('right'); layout.setFolded(false); };
  });
  const content = useCompanionPaneContent({
    documents, tabs, layout, onSelect: () => {}, onCloseDiscussion: () => { thread.closeThread(); onClosed(); },
    host: { account: null, conversation: { id: 'design-review', name: 'Design review' } as never, contacts: [], isNativeShell: false },
  });
  return { thread, tabs, layout, content };
}

test('opening a discussion shows the side panel with the Discussion tab selected, and another discussion replaces it', async () => {
  await withJsdomRoot(async mount => {
    let harness!: ReturnType<typeof useDiscussionHarness>;
    function Harness() { const value = useDiscussionHarness(() => {}); useLayoutEffect(() => { harness = value; }); return null; }
    await mount(createElement(Harness));
    assert.equal(harness.layout.isVisible, false);
    assert.equal(harness.tabs.items.some(item => item.title === 'Discussion'), false, 'No Discussion tab without an open discussion');

    await act(() => harness.thread.openThread(message('root-1', 'Can we lock the copy by Friday?')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(harness.thread.activeThreadRootId, 'root-1');
    assert.equal(harness.tabs.view, 'discussion');
    assert.equal(harness.tabs.activeId, companionViewTabId('discussion'));
    assert.equal(harness.layout.isVisible, true);
    assert.equal(harness.layout.side, 'right');

    await act(() => harness.tabs.setView('digest'));
    await act(() => harness.layout.setFolded(true));
    await act(() => harness.thread.openThread(message('root-2', 'I will send the final screens tomorrow.')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(harness.thread.activeThreadRootId, 'root-2');
    assert.equal(harness.tabs.view, 'discussion', 'Opening another discussion selects the tab again');
    assert.equal(harness.layout.isVisible, true, 'Opening a discussion unfolds the panel');
    assert.equal(harness.tabs.items.filter(item => item.id === companionViewTabId('discussion')).length, 1, 'One Discussion tab is reused');
  });
});

test('closing the Discussion tab closes the discussion, and a closed discussion removes its tab', async t => {
  await withJsdomRoot(async mount => {
    let harness!: ReturnType<typeof useDiscussionHarness>;
    let closed = 0;
    // closeThread returns focus to the main composer on the next frame.
    const frames = { requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: clearTimeout };
    for (const [key, value] of Object.entries(frames)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { for (const key of Object.keys(frames)) Reflect.deleteProperty(globalThis, key); });
    function Harness() { const value = useDiscussionHarness(() => { closed += 1; }); useLayoutEffect(() => { harness = value; }); return value.content.tabBar; }
    const host = await mount(createElement(Harness));
    await act(() => harness.tabs.setView('digest'));
    await act(() => harness.thread.openThread(message('root-1', 'Can we lock the copy by Friday?')));
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close Discussion"]');
    assert.ok(close, 'The Discussion tab has the strip close control');
    await act(() => close.click());
    assert.equal(closed, 1);
    assert.equal(harness.thread.activeThreadRootId, null);
    assert.equal(harness.tabs.view, 'digest', 'The neighbouring tab is selected');
    assert.equal(host.querySelector('button[aria-label="Close Discussion"]'), null);

    await act(() => harness.thread.openThread(message('root-1', 'Can we lock the copy by Friday?')));
    assert.equal(harness.tabs.view, 'discussion');
    await act(() => harness.thread.closeThread());
    assert.equal(harness.tabs.view, 'digest', 'Closing the discussion elsewhere drops the tab');
    assert.equal(harness.tabs.items.some(item => item.id === companionViewTabId('discussion')), false);
  });
});

test('the toolbar Chat button prefers the open discussion and stays pressed on its tab', async () => {
  assert.equal(companionToolbarView('chat', true), 'discussion');
  assert.equal(companionToolbarView('chat', false), 'chat');
  assert.equal(companionToolbarView('digest', true), 'digest');
  await withJsdomRoot(async mount => {
    const host = await mount(createElement(CompanionToolbar, {
      view: 'discussion', isOpen: true, canOpenChat: false, hasChat: false, hasDiscussion: true, hasTabs: true, onSelect: () => {}, onHide: () => {},
    }));
    const chat = host.querySelector<HTMLButtonElement>('button[aria-label="Chat"]');
    assert.ok(chat);
    assert.equal(chat.getAttribute('aria-pressed'), 'true');
    assert.equal(chat.disabled, false, 'An open discussion keeps the Chat button available');
  });
});

test('the discussion pane has no column chrome of its own', () => {
  const source = readFileSync(new URL('../src/pages/ChatThreadPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /role="separator"|cursor-col-resize|onWidthChange|style=\{\{ width/);
  assert.doesNotMatch(source, /<header|app-thread-panel-title|border-l/);
  assert.match(source, /aria-label="Message discussion"/);
  assert.match(source, /data-companion-composer-frame="true"/);
  assert.match(source, /placeholder="Add to discussion…"/);
  const page = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /threadPanel=/, 'The discussion is no longer a column beside the main chat');
  assert.match(page, /discussionPane=\{chatDiscussionPane\(/);
  assert.match(page, /onCloseDiscussion: closeThread/);
});
