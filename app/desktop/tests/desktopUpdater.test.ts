import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KORDI_MANUAL_UPDATE_URL,
  createDesktopUpdaterController,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterDownloadEvent,
  type DesktopUpdaterUpdate,
} from '../src/features/updates/desktopUpdater';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeUpdate(overrides: Partial<DesktopUpdaterUpdate> = {}): DesktopUpdaterUpdate {
  return {
    currentVersion: '0.0.1-beta.5.1',
    version: '0.0.1-beta.6',
    body: 'Signed beta.6 update',
    async downloadAndInstall() {},
    async close() {},
    ...overrides,
  };
}

function fakeAdapter(update: DesktopUpdaterUpdate | null): DesktopUpdaterAdapter & {
  checkCalls: number;
  relaunchCalls: number;
} {
  return {
    checkCalls: 0,
    relaunchCalls: 0,
    async check() {
      this.checkCalls += 1;
      return update;
    },
    async relaunch() {
      this.relaunchCalls += 1;
    },
  };
}

test('outside Tauri the controller stays idle without importing or checking plugins', async () => {
  const adapter = fakeAdapter(fakeUpdate());
  const controller = createDesktopUpdaterController({
    adapter,
    isTauriRuntime: () => false,
  });

  const state = await controller.check();

  assert.equal(state.status, 'idle');
  assert.equal(adapter.checkCalls, 0);
});

test('an available update retains the exact checked resource', async () => {
  const update = fakeUpdate();
  const adapter = fakeAdapter(update);
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => true });

  const state = await controller.check();

  assert.equal(state.status, 'available');
  assert.equal(state.currentVersion, '0.0.1-beta.5.1');
  assert.equal(state.latestVersion, '0.0.1-beta.6');
  assert.equal(controller.getCheckedUpdate(), update);
});

test('confirm downloads once, reports progress, installs, and relaunches only after success', async () => {
  const install = deferred<void>();
  let onEvent: ((event: DesktopUpdaterDownloadEvent) => void) | undefined;
  let installCalls = 0;
  const update = fakeUpdate({
    downloadAndInstall(listener) {
      installCalls += 1;
      onEvent = listener;
      return install.promise;
    },
  });
  const adapter = fakeAdapter(update);
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => true });
  const states: string[] = [];
  controller.subscribe((state) => states.push(state.status));
  await controller.check();

  const first = controller.install();
  const second = controller.install();
  assert.equal(first, second);
  assert.equal(installCalls, 1);
  assert.equal(adapter.relaunchCalls, 0);

  onEvent?.({ event: 'Started', data: { contentLength: 100 } });
  onEvent?.({ event: 'Progress', data: { chunkLength: 35 } });
  assert.deepEqual(controller.getState(), {
    status: 'downloading',
    currentVersion: '0.0.1-beta.5.1',
    latestVersion: '0.0.1-beta.6',
    notes: 'Signed beta.6 update',
    receivedBytes: 35,
    totalBytes: 100,
    manualDownloadUrl: KORDI_MANUAL_UPDATE_URL,
  });

  onEvent?.({ event: 'Finished' });
  assert.equal(controller.getState().status, 'installing');
  install.resolve();
  await first;

  assert.equal(adapter.relaunchCalls, 1);
  assert.equal(controller.getState().status, 'relaunching');
  assert.ok(states.includes('downloading'));
  assert.ok(states.includes('installing'));
  assert.ok(states.includes('relaunching'));
});

test('signature or install failure never relaunches and retry reuses the checked update', async () => {
  let attempts = 0;
  const update = fakeUpdate({
    async downloadAndInstall() {
      attempts += 1;
      if (attempts === 1) throw new Error('signature verification failed');
    },
  });
  const adapter = fakeAdapter(update);
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => true });
  await controller.check();

  await assert.rejects(controller.install(), /signature verification failed/);
  assert.equal(adapter.relaunchCalls, 0);
  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().manualDownloadUrl, KORDI_MANUAL_UPDATE_URL);

  await controller.retry();
  assert.equal(attempts, 2);
  assert.equal(adapter.checkCalls, 1);
  assert.equal(adapter.relaunchCalls, 1);
});

test('check failures stay quiet and disposing closes the held updater resource', async () => {
  let closeCalls = 0;
  const update = fakeUpdate({ async close() { closeCalls += 1; } });
  const adapter = fakeAdapter(update);
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => true });
  await controller.check();
  await controller.dispose();
  assert.equal(closeCalls, 1);
  assert.equal(controller.getCheckedUpdate(), null);

  const failingAdapter: DesktopUpdaterAdapter = {
    async check() { throw new Error('offline'); },
    async relaunch() { throw new Error('must not run'); },
  };
  const quiet = createDesktopUpdaterController({ adapter: failingAdapter, isTauriRuntime: () => true });
  assert.equal((await quiet.check()).status, 'idle');
});
