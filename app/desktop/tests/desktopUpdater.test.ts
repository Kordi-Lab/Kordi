import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDesktopUpdateController,
  type DesktopUpdateAdapter,
  type DesktopUpdateState,
} from '../src/features/update/desktopUpdater';

function stateKinds(states: DesktopUpdateState[]) {
  return states.map((state) => state.kind);
}

test('desktop updater stays idle when native updater APIs are unavailable', async () => {
  const states: DesktopUpdateState[] = [];
  const controller = createDesktopUpdateController({
    isAvailable: false,
    onStateChange: (state) => states.push(state),
  });

  const state = await controller.check();

  assert.equal(state.kind, 'idle');
  assert.deepEqual(stateKinds(states), ['checking', 'idle']);
});

test('desktop updater stays quiet when the startup update check fails', async () => {
  const states: DesktopUpdateState[] = [];
  const controller = createDesktopUpdateController({
    adapter: {
      isAvailable: true,
      async check() {
        throw new Error('not configured');
      },
      async install() {},
      async relaunch() {},
    },
    onStateChange: (state) => states.push(state),
  });

  const state = await controller.check();

  assert.equal(state.kind, 'idle');
  assert.deepEqual(stateKinds(states), ['checking', 'idle']);
});

test('desktop updater reports an available update with version metadata', async () => {
  const states: DesktopUpdateState[] = [];
  const adapter: DesktopUpdateAdapter = {
    isAvailable: true,
    async check() {
      return {
        available: true,
        version: '0.0.1-beta.4',
        currentVersion: '0.0.1-beta.3',
      };
    },
    async install() {},
    async relaunch() {},
  };
  const controller = createDesktopUpdateController({ adapter, onStateChange: (state) => states.push(state) });

  const state = await controller.check();

  assert.equal(state.kind, 'available');
  assert.equal(state.version, '0.0.1-beta.4');
  assert.equal(state.currentVersion, '0.0.1-beta.3');
  assert.deepEqual(stateKinds(states), ['checking', 'available']);
});

test('desktop updater downloads, installs, and waits for explicit restart', async () => {
  const states: DesktopUpdateState[] = [];
  let relaunched = false;
  const adapter: DesktopUpdateAdapter = {
    isAvailable: true,
    async check() {
      return { available: true, version: '0.0.1-beta.4', currentVersion: '0.0.1-beta.3' };
    },
    async install(_update, onProgress) {
      onProgress({ downloaded: 25, total: 100 });
      onProgress({ downloaded: 100, total: 100 });
    },
    async relaunch() {
      relaunched = true;
    },
  };
  const controller = createDesktopUpdateController({ adapter, onStateChange: (state) => states.push(state) });

  await controller.check();
  const installed = await controller.install();
  assert.equal(installed.kind, 'ready');
  assert.equal(installed.version, '0.0.1-beta.4');
  assert.equal(relaunched, false);

  await controller.restart();
  assert.equal(relaunched, true);
  assert.deepEqual(stateKinds(states), ['checking', 'available', 'downloading', 'downloading', 'installing', 'ready', 'restarting']);
});

test('desktop updater surfaces install failures with GitHub fallback', async () => {
  const adapter: DesktopUpdateAdapter = {
    isAvailable: true,
    async check() {
      return { available: true, version: '0.0.1-beta.4', currentVersion: '0.0.1-beta.3' };
    },
    async install() {
      throw new Error('signature missing');
    },
    async relaunch() {},
  };
  const controller = createDesktopUpdateController({ adapter });

  await controller.check();
  const state = await controller.install();

  assert.equal(state.kind, 'failed');
  assert.match(state.message, /signature missing/);
  assert.equal(state.fallbackUrl, 'https://github.com/Kordi-AI/Kordi/releases');
});
