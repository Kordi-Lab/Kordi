import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  AppDialog,
  AppDialogActions,
  AppDialogTitle,
} from '../src/components/ui/dialog';
import { DeleteSessionDialog } from '../src/pages/SessionActionOverlays';

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

test('AppDialog traps focus, dismisses with Escape, and restores the opener', async () => {
  const installed = installDom();
  const opener = document.createElement('button');
  const host = document.createElement('div');
  document.body.append(opener, host);
  opener.focus();
  let dismissCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <AppDialog titleId="test-dialog-title" onDismiss={() => { dismissCount += 1; }}>
          <AppDialogTitle id="test-dialog-title">Test dialog</AppDialogTitle>
          <AppDialogActions>
            <button type="button" autoFocus>Cancel</button>
            <button type="button">Continue</button>
          </AppDialogActions>
        </AppDialog>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(host.childElementCount, 0);
    assert.equal(dialog.closest('body'), document.body);

    const buttons = Array.from(dialog.querySelectorAll('button'));
    assert.equal(document.activeElement, buttons[0]);

    buttons[0]?.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(document.activeElement, buttons[1]);

    buttons[1]?.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(document.activeElement, buttons[0]);

    document.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(dismissCount, 1);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    assert.equal(document.activeElement, opener);
    opener.remove();
    host.remove();
    installed.restore();
  }
});

test('AppDialog blocks light dismiss while an action is busy', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let dismissCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <AppDialog
          titleId="busy-dialog-title"
          onDismiss={() => { dismissCount += 1; }}
          dismissDisabled
          busy
        >
          <AppDialogTitle id="busy-dialog-title">Busy dialog</AppDialogTitle>
          <button type="button">Working</button>
        </AppDialog>,
      );
    });

    const backdrop = document.querySelector('[data-app-dialog-backdrop="true"]');
    assert.equal(backdrop?.querySelector('[role="dialog"]')?.getAttribute('aria-busy'), 'true');
    backdrop?.dispatchEvent(new installed.dom.window.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    }));
    document.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(dismissCount, 0);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('DeleteSessionDialog keeps loading and failure feedback inside the popout', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let rejectConfirm: ((reason?: unknown) => void) | null = null;
  let cancelCount = 0;
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <DeleteSessionDialog
          target={{ sessionId: 'session:one', sessionName: 'Trip planning' }}
          onCancel={() => { cancelCount += 1; }}
          onConfirm={() => new Promise<void>((_resolve, reject) => {
            rejectConfirm = reject;
          })}
        />,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(host.contains(dialog), true);
    const buttons = Array.from(dialog.querySelectorAll('button'));
    await act(async () => buttons[1]?.click());

    assert.equal(dialog?.getAttribute('aria-busy'), 'true');
    assert.match(buttons[1]?.textContent ?? '', /Removing…/);
    assert.equal(buttons[0]?.hasAttribute('disabled'), true);

    await act(async () => {
      rejectConfirm?.(new Error('network unavailable'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const alert = dialog.querySelector('[role="alert"]');
    assert.equal(alert?.textContent, 'Could not remove chat: network unavailable');
    assert.doesNotMatch(alert?.getAttribute('class') ?? '', /\bbg-|\bborder|\brounded/);
    assert.match(buttons[1]?.textContent ?? '', /Try again/);
    assert.equal(dialog?.hasAttribute('aria-busy'), false);
    assert.equal(cancelCount, 0);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});
