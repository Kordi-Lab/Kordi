import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { useAppLayoutState } from '../src/app/useAppLayoutState';
import { LEFT_RAIL_WIDTH } from '../src/kordi-app/layout';

test('native collapse keeps the list width while moving the content boundary over it', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockIPC(() => undefined);
  const root = createRoot(document.getElementById('root')!);
  let layout!: ReturnType<typeof useAppLayoutState>;
  function Probe() {
    layout = useAppLayoutState({ activeNav: 'chats', isNativeShell: true });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    const listWidth = layout.sessionRailWidth;
    assert.ok(listWidth > 0);
    assert.equal(layout.leftWorkspaceWidth, LEFT_RAIL_WIDTH + listWidth);
    for (const collapsed of [true, false, true, false]) {
      await act(async () => layout.setIsSessionPanelCollapsed(collapsed));
      assert.equal(layout.sessionRailWidth, listWidth, 'the covered list must not collapse or reflow');
      assert.equal(layout.leftWorkspaceWidth, LEFT_RAIL_WIDTH + (collapsed ? 0 : listWidth));
      assert.equal(layout.collapseChatSessions, collapsed);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
