import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createLayoutResizeScheduler,
  NATIVE_LAYOUT_RESIZE_SETTLE_MS,
} from '../src/app/layoutResizeScheduler';
import { shallowObjectEqual } from '../src/app/useShallowStableObject';

test('native resize activity coalesces geometry work and settles after the latest event', () => {
  let nextHandle = 1;
  let starts = 0;
  let frames = 0;
  let ends = 0;
  const scheduledFrames = new Map<number, () => void>();
  const scheduledTimeouts = new Map<number, { callback: () => void; delayMs: number }>();

  const scheduler = createLayoutResizeScheduler({
    onResizeStart: () => { starts += 1; },
    onResizeFrame: () => { frames += 1; },
    onResizeEnd: () => { ends += 1; },
    scheduleFrame: (callback) => {
      const handle = nextHandle++;
      scheduledFrames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => { scheduledFrames.delete(handle); },
    scheduleTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      scheduledTimeouts.set(handle, { callback, delayMs });
      return handle;
    },
    cancelTimeout: (handle) => { scheduledTimeouts.delete(handle); },
  });

  scheduler.notifyResize();
  scheduler.notifyResize();
  scheduler.notifyResize();

  assert.equal(starts, 1);
  assert.equal(frames, 0);
  assert.equal(ends, 0);
  assert.equal(scheduledFrames.size, 1);
  assert.equal(scheduledTimeouts.size, 1);
  assert.equal([...scheduledTimeouts.values()][0]?.delayMs, NATIVE_LAYOUT_RESIZE_SETTLE_MS);

  const frame = [...scheduledFrames.values()][0];
  scheduledFrames.clear();
  frame?.();
  assert.equal(frames, 1);

  scheduler.notifyResize();
  assert.equal(starts, 1);
  assert.equal(scheduledFrames.size, 1);
  assert.equal(scheduledTimeouts.size, 1);

  const trailingFrame = [...scheduledFrames.values()][0];
  const settle = [...scheduledTimeouts.values()][0]?.callback;
  scheduledTimeouts.clear();
  settle?.();
  assert.equal(frames, 2);
  assert.equal(ends, 1);
  assert.equal(scheduledFrames.size, 0);
  trailingFrame?.();
  assert.equal(frames, 2);

  scheduler.notifyResize();
  assert.equal(starts, 2);
  scheduler.dispose();
  assert.equal(ends, 2);
  assert.equal(scheduledFrames.size, 0);
  assert.equal(scheduledTimeouts.size, 0);
});

test('shallow shell argument comparison preserves slices until a real input changes', () => {
  const handler = () => undefined;
  const first = { activeNav: 'chats', handler, width: 248 };
  const equivalent = { activeNav: 'chats', handler, width: 248 };
  const changed = { activeNav: 'chats', handler, width: 249 };

  assert.equal(shallowObjectEqual(first, equivalent), true);
  assert.equal(shallowObjectEqual(first, changed), false);
});

test('resize styling suppresses transitions without toggling native shell blur', () => {
  const frameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
  const layoutSource = readFileSync(new URL('../src/app/useAppLayoutState.ts', import.meta.url), 'utf8');
  const appCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(frameSource, /data-layout-resizing=\{isLayoutResizing \? 'true' : undefined\}/);
  assert.match(frameSource, /app-native-viewport/);
  assert.match(frameSource, /app-shell-layout-grid/);
  assert.doesNotMatch(frameSource, /isLayoutResizing \? 'backdrop-blur-none'/);
  assert.doesNotMatch(frameSource, /app-shell-resizing/);
  assert.doesNotMatch(shellCss, /\.app-shell-resizing/);
  assert.match(shellCss, /\.app-native-viewport\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
  assert.match(shellCss, /\.app-native-viewport > \.app-shell\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*backdrop-filter:\s*none;/);
  assert.match(shellCss, /html\.kordi-native-window-resizing \.app-shell/);
  assert.match(shellCss, /\.app-shell\[data-layout-resizing='true'\]\) \*[\s\S]*transition:\s*none\s*!important;/);
  assert.doesNotMatch(appCss + shellCss, /\.app-shell\[data-layout-resizing='true'\][^{]*\{[^}]*backdrop-filter:\s*none/);
  assert.match(layoutSource, /onResizeFrame:\s*syncNativeWindowSize/);
  assert.match(layoutSource, /if \(current\.width === next\.width\) return;/);
  assert.match(layoutSource, /\{ width: next\.width, height: current\.height \}/);
  assert.doesNotMatch(layoutSource, /pendingNativeWindowSizeRef/);
});
