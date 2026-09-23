import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudOAuthCancelledError } from '../src/features/cloud/cloudOAuthCancellation';
import { CloudLoginPage } from '../src/kordi-app/cloud/CloudLoginPage';

test('canceling social sign-in enables Google again without showing an error', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
  });
  const values = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  let rejectFirst!: (error: Error) => void;
  let attempts = 0;
  try {
    await act(async () => root.render(createElement(CloudLoginPage, {
      onModeChange: () => {},
      onSocialSignIn: async () => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
        }
      },
    })));
    const google = document.querySelector<HTMLButtonElement>('[data-provider="google"]')!;
    await act(async () => { google.click(); });
    assert.equal(google.disabled, true);

    await act(async () => { rejectFirst(new CloudOAuthCancelledError()); });
    assert.equal(google.disabled, false);
    assert.equal(document.querySelector('[role="alert"]'), null);

    await act(async () => { google.click(); });
    assert.equal(attempts, 2);
    assert.equal(google.disabled, false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
