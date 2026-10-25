import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import { shouldStartNativeWindowDrag } from '../src/app/windowDrag';
import {
  applyAuthWindowCrop,
  readAuthWindowCrop,
  readAuthWindowCropOffset,
  subscribeAuthWindowCrop,
} from '../src/features/cloud/loginWindow';

test('gate crop follows the native web view offset in CSS pixels', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const values = { window: dom.window, document: dom.window.document };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const style = document.documentElement.style;
  const seen: Array<{ x: number; y: number }> = [];
  const stop = subscribeAuthWindowCrop(crop => seen.push(crop));
  try {
    applyAuthWindowCrop({ x: 360, y: 110 });
    assert.deepEqual(readAuthWindowCrop(), { x: 360, y: 110 });
    assert.equal(style.getPropertyValue('--app-gate-crop-x'), '360px');
    assert.equal(style.getPropertyValue('--app-gate-crop-y'), '110px');

    document.documentElement.dataset.kordiInterfaceZoom = '2';
    applyAuthWindowCrop({ x: 360, y: 110 });
    assert.equal(style.getPropertyValue('--app-gate-crop-x'), '180px');
    assert.equal(style.getPropertyValue('--app-gate-crop-y'), '55px');
    assert.deepEqual(readAuthWindowCropOffset(), { x: 180, y: 55 });

    // Mocked IPC resolves undefined; the last reported crop stays.
    applyAuthWindowCrop(undefined);
    assert.deepEqual(readAuthWindowCrop(), { x: 360, y: 110 });
    assert.deepEqual(seen, [{ x: 360, y: 110 }]);

    applyAuthWindowCrop({ x: 0, y: 0 });
    assert.equal(style.getPropertyValue('--app-gate-crop-y'), '0px');
  } finally {
    stop();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('gate drag hit-test starts at the visible window top', () => {
  const gesture = { isNativeShell: true, button: 0, shellTop: 110, target: null };
  assert.equal(shouldStartNativeWindowDrag({ ...gesture, clientY: 140 }), true);
  assert.equal(shouldStartNativeWindowDrag({ ...gesture, clientY: 40 }), false);
});
