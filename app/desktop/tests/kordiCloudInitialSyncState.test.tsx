import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useKordiCloudInitialSyncState } from '../src/app/useKordiCloudInitialSyncState';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  });
  return {
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('cloud initial sync stays ready for a completed account and resets on account change', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let accountId: string | null = 'acct_a';
  let canonicalSettled = true;
  let refreshCount = 0;
  let latest: ReturnType<typeof useKordiCloudInitialSyncState> | null = null;
  const refresh = () => {
    refreshCount += 1;
  };

  function Harness() {
    latest = useKordiCloudInitialSyncState({
      accountId,
      cachedMessagesReady: false,
      canonicalError: null,
      canonicalSettled,
      canonicalState: null,
      contactsSettled: true,
      desktopChatSettled: true,
      messagesSettled: true,
      refreshCanonicalState: refresh,
      refreshCloudContacts: refresh,
      refreshCloudMessages: refresh,
      resetCanonicalRefresh: refresh,
    });
    return null;
  }

  try {
    await act(async () => root?.render(<Harness />));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(latest?.status, 'ready');

    canonicalSettled = false;
    await act(async () => root?.render(<Harness />));
    assert.equal(
      latest?.status,
      'ready',
      'a completed account must not return to the startup gate during background refresh',
    );

    accountId = 'acct_b';
    await act(async () => root?.render(<Harness />));
    assert.equal(
      latest?.status,
      'syncing',
      'switching accounts must not reuse the previous account readiness',
    );

    await act(async () => latest?.onRetry());
    assert.equal(refreshCount, 4);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});
