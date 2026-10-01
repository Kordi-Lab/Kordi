import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { Message } from '../src/kordi-app/types';
import { MessageDeleteDialog } from '../src/pages/MessageDeleteDialog';

const ownMessage: Message = { role: 'user', sender: 'Me', senderType: 'human', text: 'Delete me', time: '10:42' };
const peerMessage: Message = { ...ownMessage, role: 'person', sender: 'Alice', isOwnMessage: false };

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

async function renderDialog(element: React.ReactElement) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(element));
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  return {
    installed,
    dialog,
    button: (name: RegExp) => {
      const match = Array.from(dialog.querySelectorAll('button')).find((button) => name.test(button.textContent ?? ''));
      assert.ok(match, `missing button ${name}`);
      return match;
    },
    describedText: (element: Element) => (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      installed.restore();
    },
  };
}

test('own message choices are labelled buttons with linked helpers and Cancel keeps focus', async () => {
  const view = await renderDialog(
    <MessageDeleteDialog message={ownMessage} peerName="Alice" group serverDeletesStoredCopies
      onCancel={() => undefined} onDelete={async () => undefined} />,
  );
  try {
    const buttons = Array.from(view.dialog.querySelectorAll('button')).map((button) => button.textContent);
    assert.deepEqual(buttons, ['Remove from my view', 'Delete for everyone', 'Cancel']);
    const cancel = view.button(/^Cancel$/);
    assert.equal(document.activeElement, cancel);
    assert.equal(
      view.describedText(view.button(/^Remove from my view$/)),
      'Hides it on your devices. Others in the chat still see it.',
    );
    assert.equal(
      view.describedText(view.button(/^Delete for everyone$/)),
      'Removes it for everyone in this chat, and Kordi deletes its text and files from chat storage.',
    );
    assert.match(view.describedText(view.dialog), /^People who already saw it may have saved a copy/);
    assert.match(view.dialog.className, /max-w-\[22rem\]/);

    // Cancel is last, so the dialog focus trap moves Tab from Cancel to the first choice.
    cancel.dispatchEvent(new view.installed.dom.window.KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    assert.equal(document.activeElement, view.button(/^Remove from my view$/));
  } finally {
    await view.cleanup();
  }
});

for (const [label, busyLabel, forEveryone] of [
  [/^Delete for everyone$/, /Deleting…/, true],
  [/^Remove from my view$/, /Removing…/, false],
] as const) {
  test(`pressing ${busyLabel.source} busies only that button and reports failures`, async () => {
    const calls: boolean[] = [];
    let reject!: (reason?: unknown) => void;
    let cancelCount = 0;
    const view = await renderDialog(
      <MessageDeleteDialog message={ownMessage} peerName="Alice" group={false}
        onCancel={() => { cancelCount += 1; }}
        onDelete={(value) => {
          calls.push(value);
          return new Promise<void>((_resolve, rejectDelete) => { reject = rejectDelete; });
        }} />,
    );
    try {
      const pressed = view.button(label);
      await act(async () => pressed.click());
      assert.deepEqual(calls, [forEveryone]);
      assert.match(pressed.textContent ?? '', busyLabel);
      assert.equal(pressed.getAttribute('aria-busy'), 'true');
      const others = Array.from(view.dialog.querySelectorAll('button')).filter((button) => button !== pressed);
      assert.ok(others.every((button) => button.disabled && !button.hasAttribute('aria-busy')));

      await act(async () => {
        reject(new Error('Server detail that is not shown'));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(view.dialog.querySelector('[role="alert"]')?.textContent, 'Could not delete the message. Try again.');
      assert.ok(Array.from(view.dialog.querySelectorAll('button')).every((button) => !button.disabled));
      assert.equal(pressed.hasAttribute('aria-busy'), false);
      assert.equal(cancelCount, 0);
    } finally {
      await view.cleanup();
    }
  });
}

test("someone else's message gets the remove-only dialog", async () => {
  const calls: boolean[] = [];
  let cancelCount = 0;
  const view = await renderDialog(
    <MessageDeleteDialog message={peerMessage} peerName="Alice" group={false} serverDeletesStoredCopies
      onCancel={() => { cancelCount += 1; }}
      onDelete={async (value) => { calls.push(value); }} />,
  );
  try {
    assert.equal(view.dialog.querySelector('h2')?.textContent, 'Remove this message from your view?');
    assert.equal(view.describedText(view.dialog), 'Others in the chat still see it.');
    const buttons = Array.from(view.dialog.querySelectorAll('button')).map((button) => button.textContent);
    assert.deepEqual(buttons, ['Cancel', 'Remove from my view']);
    assert.equal(document.activeElement, view.button(/^Cancel$/));
    await act(async () => view.button(/^Remove from my view$/).click());
    assert.deepEqual(calls, [false]);
    assert.equal(cancelCount, 1);
  } finally {
    await view.cleanup();
  }
});
