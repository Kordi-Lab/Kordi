import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { NativeChatTitlebarContext } from '../src/app/nativeChatTitlebarContext';
import type { Conversation } from '../src/kordi-app/types';
import { CompanionHeader } from '../src/pages/chatsPage.companionHeader';
import type { ChatDestination } from '../src/pages/chatsPage.destinationModel';
import { CompanionTitlebarContext } from '../src/pages/companionTitlebarContext';

const conversation: Conversation = {
  id: 'agent-session',
  name: 'Review the homepage',
  type: 'owned-agent',
  subtitle: 'Agent session',
  unread: 0,
  collaborationSources: [],
  trust: 'Owned',
  directness: 'Direct chat',
  participants: ['Kordi'],
  messages: [],
};

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
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

function Harness({ selections }: { selections: ChatDestination[] }) {
  const [destination, setDestination] = useState<ChatDestination>('messages');
  return (
    <CompanionHeader
      conversation={conversation}
      sessionOptions={[]}
      side="right"
      destination={destination}
      menu={{ actionsOpen: false, sessionListOpen: false, canCreateSession: true }}
      actions={{
        onDragStart: () => undefined,
        onDragEnd: () => undefined,
        onToggleActions: () => undefined,
        onCloseActions: () => undefined,
        onCloseSessionList: () => undefined,
        onOpenSessionList: () => undefined,
        onSwitchConversation: () => undefined,
        onCreateSession: () => undefined,
        onClose: () => undefined,
        onSelectDestination: (next) => {
          selections.push(next);
          setDestination(next);
        },
      }}
    />
  );
}

const tabLabels = (root: ParentNode) => Array.from(
  root.querySelectorAll('[data-chat-destination-tabs="companion"] [role="tab"]'),
  (tab) => tab.textContent,
);
const activeTab = (root: ParentNode) => root.querySelector(
  '[data-chat-destination-tabs="companion"] [aria-selected="true"]',
);

test('Ask Agent header uses the main chat title row and routes the shared destination tabs', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selections: ChatDestination[] = [];
  try {
    await act(async () => root.render(<Harness selections={selections} />));
    const header = host.querySelector('.app-chat-pane-header');
    assert.ok(header);
    assert.equal(header.getAttribute('data-has-destinations'), 'true');
    const heading = header.querySelector('.app-chat-pane-title-row h2');
    assert.equal(heading?.textContent?.replace(/\u00a0/g, ' '), 'Ask Agent · Review the homepage');
    assert.equal(heading?.querySelector('[data-companion-title-context="true"]')?.textContent, 'Ask Agent');
    assert.ok(header.querySelector('[aria-label="Side chat options"].app-companion-header-control'));
    assert.ok(header.querySelector('[aria-label="Close side chat"].app-companion-header-control'));

    assert.deepEqual(tabLabels(header), ['Messages', 'Info', 'Artifacts', 'Tasks']);
    assert.equal(activeTab(header)?.getAttribute('data-chat-destination-tab'), 'messages');
    assert.ok(activeTab(header)?.classList.contains('app-chat-destination-tab-active'));

    for (const destination of ['info', 'artifacts', 'tasks'] as const) {
      const tab = header.querySelector<HTMLButtonElement>(`[data-chat-destination-tab="${destination}"]`);
      await act(async () => tab?.click());
      assert.equal(activeTab(header)?.getAttribute('data-chat-destination-tab'), destination);
      assert.equal(activeTab(header)?.id, `chat-companion-${destination}-tab`);
      assert.equal(activeTab(header)?.getAttribute('aria-controls'), `chat-companion-${destination}-panel`);
    }
    await act(async () => {
      activeTab(header)?.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(selections, ['info', 'artifacts', 'tasks', 'messages']);
    assert.equal(activeTab(header)?.getAttribute('data-chat-destination-tab'), 'messages');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('on the native title row the panel keeps its tabs in a main-chat style metadata header', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  const titlebar = document.createElement('div');
  document.body.append(host, titlebar);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <NativeChatTitlebarContext value={{ title: null, actions: null, companion: titlebar }}>
        <CompanionTitlebarContext value={{ width: '420px', side: 'right', isVisible: true }}>
          <Harness selections={[]} />
        </CompanionTitlebarContext>
      </NativeChatTitlebarContext>,
    ));
    const titleHeader = titlebar.querySelector('.app-native-companion-titlebar .app-chat-pane-header');
    assert.ok(titleHeader?.querySelector('.app-chat-pane-title-row'));
    assert.ok(titleHeader?.querySelector('[aria-label="Close side chat"]'));
    assert.equal(titleHeader?.querySelector('[data-chat-destination-tabs]'), null);
    assert.equal(titleHeader?.hasAttribute('data-has-destinations'), false);

    const tabHeader = host.querySelector('.app-chat-pane-header.app-chat-native-metadata-header');
    assert.ok(tabHeader);
    assert.equal(tabHeader.getAttribute('data-has-destinations'), 'true');
    assert.equal(tabHeader.querySelector('.app-chat-pane-title-row'), null);
    assert.deepEqual(tabLabels(tabHeader), ['Messages', 'Info', 'Artifacts', 'Tasks']);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
