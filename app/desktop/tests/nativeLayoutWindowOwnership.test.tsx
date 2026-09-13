import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';

import { useAppLayoutState } from '../src/app/useAppLayoutState';
import { getWorkspaceWindowMinWidth } from '../src/kordi-app/layout';
import { KORDI_MAIN_WINDOW_SIZE } from '../src/features/cloud/loginWindow';

test('mounting the workspace inside a compact auth window cannot issue a competing resize', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: 760, configurable: true });
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const calls: string[] = [];
  mockIPC(command => { calls.push(command); });
  const root = createRoot(document.getElementById('root')!);
  function Probe({ nav }: { nav: 'chats' | 'projects' }) {
    useAppLayoutState({ activeNav: nav, isNativeShell: true });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe, { nav: 'chats' })));
    await act(async () => root.render(createElement(Probe, { nav: 'projects' })));
    // Flush lazy imports so the prior native resize effect would be observed.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.deepEqual(calls, []);
    assert.ok(KORDI_MAIN_WINDOW_SIZE.minWidth >= getWorkspaceWindowMinWidth({
      showSessionRail: true, collapseChatSessions: false, showRightDetailRail: true, isDetailPanelCollapsed: false,
    }));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
