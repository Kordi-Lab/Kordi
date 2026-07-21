import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  APP_WINDOW_DRAG_HEIGHT,
  APP_WINDOW_RESIZE_GUARD,
  shouldStartNativeWindowDrag,
} from '../src/app/windowDrag';

const centeredWindowPointer = {
  clientX: 500,
  shellLeft: 0,
  shellRight: 1000,
};

test('native shell starts window drag from non-interactive top chrome', () => {
  const target = { closest: () => null } as unknown as EventTarget;

  assert.equal(
    shouldStartNativeWindowDrag({
      ...centeredWindowPointer,
      isNativeShell: true,
      button: 0,
      clientY: 24,
      shellTop: 0,
      target,
    }),
    true,
  );
});

test('window drag ignores non-native, non-left-click, and content below chrome band', () => {
  const target = { closest: () => null } as unknown as EventTarget;

  assert.equal(
    shouldStartNativeWindowDrag({
      ...centeredWindowPointer,
      isNativeShell: false,
      button: 0,
      clientY: 24,
      shellTop: 0,
      target,
    }),
    false,
  );
  assert.equal(
    shouldStartNativeWindowDrag({
      ...centeredWindowPointer,
      isNativeShell: true,
      button: 2,
      clientY: 24,
      shellTop: 0,
      target,
    }),
    false,
  );
  assert.equal(
    shouldStartNativeWindowDrag({
      ...centeredWindowPointer,
      isNativeShell: true,
      button: 0,
      clientY: APP_WINDOW_DRAG_HEIGHT + 1,
      shellTop: 0,
      target,
    }),
    false,
  );
});

test('window drag does not steal clicks from controls or explicit no-drag regions', () => {
  let selectorUsed = '';
  const blockedTarget = {
    closest: (selector: string) => {
      selectorUsed = selector;
      return { tagName: 'BUTTON' };
    },
  } as unknown as EventTarget;

  assert.equal(
    shouldStartNativeWindowDrag({
      ...centeredWindowPointer,
      isNativeShell: true,
      button: 0,
      clientY: 24,
      shellTop: 0,
      target: blockedTarget,
    }),
    false,
  );
  assert.match(selectorUsed, /button/);
  assert.match(selectorUsed, /\[data-kordi-window-drag="false"\]/);
  assert.match(selectorUsed, /\[data-tauri-drag-region="false"\]/);
});

test('window drag leaves every native resize edge to AppKit', () => {
  const target = { closest: () => null } as unknown as EventTarget;
  const base = {
    isNativeShell: true,
    button: 0,
    shellLeft: 0,
    shellRight: 1000,
    shellTop: 0,
    target,
  };

  assert.equal(shouldStartNativeWindowDrag({
    ...base,
    clientX: APP_WINDOW_RESIZE_GUARD - 1,
    clientY: 24,
  }), false);
  assert.equal(shouldStartNativeWindowDrag({
    ...base,
    clientX: 1000 - APP_WINDOW_RESIZE_GUARD + 1,
    clientY: 24,
  }), false);
  assert.equal(shouldStartNativeWindowDrag({
    ...base,
    clientX: 500,
    clientY: APP_WINDOW_RESIZE_GUARD - 1,
  }), false);
});

test('desktop capabilities allow explicit Tauri startDragging calls', () => {
  const capabilities = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8')) as {
    permissions?: string[];
  };

  assert.equal(capabilities.permissions?.includes('core:window:allow-start-dragging'), true);
});
