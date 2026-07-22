import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createNativeLiveResizeRectGate } from '../src/app/nativeLiveResizeRect';
import type { NativeLiveResizeSnapshot } from '../src/app/nativeLiveResize';

function resizeState(
  active: boolean,
  direction: NativeLiveResizeSnapshot['direction'],
): NativeLiveResizeSnapshot {
  return { active, direction, sequence: 1 };
}

test('vertical native resize defers transcript geometry until the exact end event', () => {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const emitted: Array<{ width: number; height: number }> = [];
  const gate = createNativeLiveResizeRectGate(
    (rect) => emitted.push(rect),
    {
      schedule: (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancel: (handle) => { frames.delete(handle); },
    },
  );

  gate.receive({ width: 900, height: 700 }, resizeState(false, null));
  gate.receive({ width: 900, height: 680 }, resizeState(true, 'top'));
  gate.receive({ width: 900, height: 660 }, resizeState(true, 'top'));

  assert.deepEqual(emitted, [{ width: 900, height: 700 }]);
  assert.equal(frames.size, 0);

  gate.finish({ width: 900, height: 640 });
  assert.deepEqual(emitted, [
    { width: 900, height: 700 },
    { width: 900, height: 640 },
  ]);
});

test('horizontal and corner resize geometry is coalesced to one update per frame', () => {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const emitted: Array<{ width: number; height: number }> = [];
  const gate = createNativeLiveResizeRectGate(
    (rect) => emitted.push(rect),
    {
      schedule: (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancel: (handle) => { frames.delete(handle); },
    },
  );

  gate.receive({ width: 880, height: 700 }, resizeState(true, 'right'));
  gate.receive({ width: 860, height: 700 }, resizeState(true, 'right'));
  gate.receive({ width: 840, height: 680 }, resizeState(true, 'top-right'));

  assert.equal(frames.size, 1);
  const frame = [...frames.values()][0];
  frames.clear();
  frame?.();
  assert.deepEqual(emitted, [{ width: 840, height: 680 }]);
});

test('native layout avoids per-pixel React state and WebView geometry overrides', () => {
  const layoutSource = readFileSync(new URL('../src/app/useAppLayoutState.ts', import.meta.url), 'utf8');
  const bridgeSource = readFileSync(new URL('../src/app/nativeLiveResize.ts', import.meta.url), 'utf8');
  const frameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
  const nativeSource = readFileSync(new URL('../src-tauri/src/macos/live_resize.rs', import.meta.url), 'utf8');
  const resizeHandler = layoutSource.slice(
    layoutSource.indexOf('const handleWindowResize'),
    layoutSource.indexOf('const handlePointerMove'),
  );

  assert.match(layoutSource, /if \(!isNativeShell\) window\.addEventListener\('resize'/);
  assert.match(layoutSource, /subscribeNativeLiveResize/);
  assert.match(layoutSource, /if \(state\.active\) return/);
  assert.doesNotMatch(resizeHandler, /isNativeShell|getViewportFillSize/);
  assert.match(bridgeSource, /kordi-native-live-resize-start/);
  assert.match(bridgeSource, /kordi-native-live-resize-end/);
  assert.match(frameSource, /APP_WINDOW_RESIZE_GUARD/);
  assert.match(nativeSource, /NSWindowWillStartLiveResizeNotification/);
  assert.match(nativeSource, /NSWindowDidEndLiveResizeNotification/);
  assert.match(nativeSource, /WebKit2UseRemoteLayerTreeDrawingArea/);
  assert.match(nativeSource, /registerDefaults/);
  assert.doesNotMatch(nativeSource, /NSWindowDidResizeNotification/);
  assert.doesNotMatch(nativeSource, /_holdWindowResizeSnapshotIfNeeded/);
  assert.doesNotMatch(nativeSource, /setPreservesContentDuringLiveResize/);
  assert.doesNotMatch(nativeSource, /setFrame|setBounds|setAutoresizingMask/);
  assert.doesNotMatch(nativeSource, /NSViewLayerContentsRedrawPolicy|CATransaction/);
  assert.doesNotMatch(nativeSource, /setPosition|set_position/);
});

test('native viewport follows normal WebKit layout without a fixed paint layer', () => {
  const stylesheet = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const viewportRule = stylesheet.slice(
    stylesheet.indexOf('.app-native-viewport {'),
    stylesheet.indexOf('.app-native-viewport > .app-shell'),
  );

  assert.match(viewportRule, /width:\s*100%/);
  assert.match(viewportRule, /height:\s*100%/);
  assert.doesNotMatch(viewportRule, /position:\s*(?:fixed|absolute)/);
  assert.doesNotMatch(viewportRule, /contain:/);
});

test('macOS titlebar layout remains owned by AppKit during live resize', () => {
  const config = JSON.parse(readFileSync(
    new URL('../src-tauri/tauri.conf.json', import.meta.url),
    'utf8',
  )) as { app?: { windows?: Array<Record<string, unknown>> } };
  const mainWindow = config.app?.windows?.find((window) => window.label === 'main');

  assert.equal(mainWindow?.titleBarStyle, 'Overlay');
  assert.equal(mainWindow?.trafficLightPosition, undefined);
});
