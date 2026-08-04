import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { Conversation } from '../src/kordi-app/types';
import { CompanionHeader } from '../src/pages/chatsPage.companionHeader';

const conversation: Conversation = {
  id: 'agent-session',
  name: 'My Kordi',
  type: 'owned-agent',
  subtitle: 'Agent session',
  unread: 0,
  collaborationSources: [],
  trust: 'Owned',
  directness: 'Direct chat',
  participants: ['My Kordi'],
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

test('side chat options dismiss outside, close on Escape, and close after creating a chat', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let createCount = 0;
  let root: Root | null = createRoot(host);

  function Harness() {
    const [actionsOpen, setActionsOpen] = useState(true);
    const [sessionListOpen, setSessionListOpen] = useState(false);
    const closeActions = () => {
      setActionsOpen(false);
      setSessionListOpen(false);
    };
    return (
      <>
        <CompanionHeader
          conversation={conversation}
          candidates={[conversation]}
          side="right"
          destination="messages"
          menu={{ actionsOpen, sessionListOpen, canCreateSession: true }}
          actions={{
            onDragStart: () => undefined,
            onDragEnd: () => undefined,
            onToggleActions: () => {
              setActionsOpen((open) => !open);
              setSessionListOpen(false);
            },
            onCloseActions: closeActions,
            onCloseSessionList: () => setSessionListOpen(false),
            onOpenSessionList: () => setSessionListOpen(true),
            onSwitchConversation: closeActions,
            onCreateSession: () => { createCount += 1; },
            onClose: closeActions,
            onSelectDestination: () => undefined,
          }}
        />
        <button type="button" data-outside-target="true">Outside</button>
      </>
    );
  }

  try {
    await act(async () => root?.render(<Harness />));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Side chat options"]');
    const outside = host.querySelector<HTMLButtonElement>('[data-outside-target="true"]');
    assert.ok(trigger);
    assert.ok(outside);
    assert.ok(host.querySelector('[data-side-chat-options-menu="true"]'));

    await act(async () => {
      host.querySelector('[data-side-chat-options-menu="true"]')?.dispatchEvent(
        new installed.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }),
      );
    });
    assert.ok(host.querySelector('[data-side-chat-options-menu="true"]'));

    await act(async () => {
      outside.dispatchEvent(
        new installed.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(host.querySelector('[data-side-chat-options-menu="true"]'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');

    await act(async () => trigger.click());
    trigger.focus();
    await act(async () => {
      document.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-side-chat-options-menu="true"]'), null);
    assert.equal(document.activeElement, trigger);

    await act(async () => trigger.click());
    const createButton = host.querySelector<HTMLButtonElement>('[aria-label="New chat"]');
    assert.ok(createButton);
    await act(async () => createButton.click());
    assert.equal(createCount, 1);
    assert.equal(host.querySelector('[data-side-chat-options-menu="true"]'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});
