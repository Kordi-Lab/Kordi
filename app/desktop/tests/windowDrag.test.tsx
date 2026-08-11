import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  APP_WINDOW_DRAG_HEIGHT,
  APP_WINDOW_RESIZE_CORNER,
  APP_WINDOW_RESIZE_EDGE,
  CLOUD_LOGIN_WINDOW_DRAG_STYLE,
  nativeWindowResizeDirection,
  shouldStartNativeWindowDrag,
} from '../src/app/windowDrag';

const shellBounds = {
  left: 0,
  top: 0,
  right: 1200,
  bottom: 800,
};

test('native shell reserves all edge and corner hit bands for directional resize', () => {
  const pointForDirection = {
    NorthWest: [APP_WINDOW_RESIZE_EDGE, APP_WINDOW_RESIZE_EDGE],
    North: [600, APP_WINDOW_RESIZE_EDGE],
    NorthEast: [1200 - APP_WINDOW_RESIZE_EDGE, APP_WINDOW_RESIZE_EDGE],
    East: [1200 - APP_WINDOW_RESIZE_EDGE, 400],
    SouthEast: [1200 - APP_WINDOW_RESIZE_EDGE, 800 - APP_WINDOW_RESIZE_EDGE],
    South: [600, 800 - APP_WINDOW_RESIZE_EDGE],
    SouthWest: [APP_WINDOW_RESIZE_EDGE, 800 - APP_WINDOW_RESIZE_EDGE],
    West: [APP_WINDOW_RESIZE_EDGE, 400],
  } as const;

  for (const [direction, [clientX, clientY]] of Object.entries(pointForDirection)) {
    assert.equal(
      nativeWindowResizeDirection({
        isNativeShell: true,
        button: 0,
        clientX,
        clientY,
        shellBounds,
      }),
      direction,
    );
  }
});

test('native resize routing ignores interior, non-native, and non-left gestures', () => {
  const gesture = {
    isNativeShell: true,
    button: 0,
    clientX: 600,
    clientY: 400,
    shellBounds,
  };

  assert.equal(nativeWindowResizeDirection(gesture), null);
  assert.equal(nativeWindowResizeDirection({ ...gesture, clientY: 8, isNativeShell: false }), null);
  assert.equal(nativeWindowResizeDirection({ ...gesture, clientY: 8, button: 2 }), null);
  assert.equal(nativeWindowResizeDirection({ ...gesture, clientX: 1201, clientY: 8 }), null);
});

test('corner direction stays ergonomic along either adjacent edge', () => {
  assert.equal(
    nativeWindowResizeDirection({
      isNativeShell: true,
      button: 0,
      clientX: shellBounds.right - APP_WINDOW_RESIZE_EDGE,
      clientY: shellBounds.top + APP_WINDOW_RESIZE_CORNER - 1,
      shellBounds,
    }),
    'NorthEast',
  );
  assert.equal(
    nativeWindowResizeDirection({
      isNativeShell: true,
      button: 0,
      clientX: shellBounds.right - APP_WINDOW_RESIZE_CORNER + 1,
      clientY: shellBounds.top + APP_WINDOW_RESIZE_EDGE,
      shellBounds,
    }),
    'NorthEast',
  );
});

test('native shell starts window drag from non-interactive top chrome', () => {
  const target = { closest: () => null } as unknown as EventTarget;

  assert.equal(
    shouldStartNativeWindowDrag({
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

test('desktop capabilities allow explicit Tauri move and directional resize calls', () => {
  const capabilities = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8')) as {
    permissions?: string[];
  };
  const frameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
  const gateSource = readFileSync(new URL('../src/KordiApp.tsx', import.meta.url), 'utf8');
  const loginSource = readFileSync(new URL('../src/kordi-app/cloud/CloudLoginPage.tsx', import.meta.url), 'utf8');

  assert.equal(capabilities.permissions?.includes('core:window:allow-start-dragging'), true);
  assert.equal(capabilities.permissions?.includes('core:window:allow-start-resize-dragging'), true);
  assert.match(frameSource, /startResizeDragging\(resizeDirection\)/);
  assert.ok(
    frameSource.indexOf('nativeWindowResizeDirection({')
      < frameSource.indexOf('shouldStartNativeWindowDrag({'),
    'edge resize routing must run before the titlebar move fallback',
  );
  assert.ok(
    gateSource.indexOf('nativeWindowResizeDirection({')
      < gateSource.indexOf('shouldStartNativeWindowDrag({'),
    'the login gate must preserve the same resize-before-move priority',
  );
  assert.match(frameSource, /top: `\$\{APP_WINDOW_RESIZE_EDGE\}px`/);
  assert.match(loginSource, /style=\{CLOUD_LOGIN_WINDOW_DRAG_STYLE\}/);
  assert.equal(CLOUD_LOGIN_WINDOW_DRAG_STYLE.top, `${APP_WINDOW_RESIZE_EDGE}px`);
});
