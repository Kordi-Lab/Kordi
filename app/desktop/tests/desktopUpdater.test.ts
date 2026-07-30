import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDesktopUpdaterController,
  desktopUpdaterCheckErrorMessage,
  desktopUpdaterInstallErrorMessage,
  manualUpdateUrlForVersion,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterDownloadEvent,
  type DesktopUpdaterUpdate,
} from '../src/features/updates/desktopUpdater';

const BETA6_MANUAL_UPDATE_URL =
  'https://kordi.ai/updates/releases/0.0.1-beta.6/Kordi_0.0.1-beta.6_aarch64.dmg';

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
    async currentVersion() {
      return update?.currentVersion ?? '0.0.1-beta.7';
    },
  };
}

test('manual fallback is product-origin and version-immutable', () => {
  assert.equal(manualUpdateUrlForVersion('0.0.1-beta.6'), BETA6_MANUAL_UPDATE_URL);
  assert.equal(
    manualUpdateUrlForVersion('10.20.30-beta.4'),
    'https://kordi.ai/updates/releases/10.20.30-beta.4/Kordi_10.20.30-beta.4_aarch64.dmg',
  );
  for (const value of [
    undefined,
    '',
    'latest',
    '../beta.6',
    '0.0.1-beta.06',
    'https://evil.invalid/x',
  ]) {
    assert.equal(manualUpdateUrlForVersion(value), undefined);
  }
});

test('serialized native updater errors become actionable messages', () => {
  assert.equal(
    desktopUpdaterInstallErrorMessage(
      'error sending request for url (https://coordinar.io/updates/releases/0.0.1-beta.8/Kordi.app.tar.gz)',
    ),
    'Download interrupted. Check your connection and try again.',
  );
  assert.equal(
    desktopUpdaterInstallErrorMessage('signature verification failed'),
    'Kordi could not verify this update. Download it manually instead.',
  );
  assert.equal(
    desktopUpdaterInstallErrorMessage('permission denied while replacing Kordi.app'),
    'Kordi needs permission to replace the app. Download it manually instead.',
  );
  assert.equal(
    desktopUpdaterInstallErrorMessage('unexpected archive layout'),
    'unexpected archive layout',
  );
  assert.equal(
    desktopUpdaterCheckErrorMessage('network connection was lost'),
    'Unable to reach the update server. Check your connection and try again.',
  );
});

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
  assert.equal(state.manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
  assert.equal(controller.getCheckedUpdate(), update);
});

test('concurrent checks share one request and publish checking then up-to-date', async () => {
  const result = deferred<DesktopUpdaterUpdate | null>();
  let checkCalls = 0;
  const controller = createDesktopUpdaterController({
    adapter: {
      async check() {
        checkCalls += 1;
        return result.promise;
      },
      async currentVersion() {
        return '0.0.1-beta.7';
      },
      async relaunch() {},
    },
    isTauriRuntime: () => true,
  });
  const states: string[] = [];
  controller.subscribe((state) => states.push(state.status));

  const first = controller.check();
  const second = controller.check();

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(checkCalls, 1);
  assert.equal(controller.getState().status, 'checking');

  result.resolve(null);
  assert.deepEqual(await first, {
    status: 'up-to-date',
    currentVersion: '0.0.1-beta.7',
  });
  assert.deepEqual(states, ['checking', 'up-to-date']);
});

test('a failed check stays visible and retry performs a new check', async () => {
  let checkCalls = 0;
  const controller = createDesktopUpdaterController({
    adapter: {
      async check() {
        checkCalls += 1;
        if (checkCalls === 1) throw new Error('update service offline');
        return null;
      },
      async currentVersion() {
        return '0.0.1-beta.7';
      },
      async relaunch() {},
    },
    isTauriRuntime: () => true,
  });

  assert.deepEqual(await controller.check(), {
    status: 'failed',
    currentVersion: '0.0.1-beta.7',
    failureStage: 'check',
    error: 'update service offline',
  });

  const retried = await controller.retry();
  assert.equal(checkCalls, 2);
  assert.deepEqual(retried, {
    status: 'up-to-date',
    currentVersion: '0.0.1-beta.7',
  });
});

test('a failed recheck preserves the known manual-download recovery', async () => {
  const update = fakeUpdate();
  let checkCalls = 0;
  const controller = createDesktopUpdaterController({
    adapter: {
      async check() {
        checkCalls += 1;
        if (checkCalls === 1) return update;
        throw new Error('temporary network failure');
      },
      async currentVersion() {
        return update.currentVersion;
      },
      async relaunch() {},
    },
    isTauriRuntime: () => true,
  });

  await controller.check();
  const failed = await controller.check();

  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureStage, 'check');
  assert.equal(failed.latestVersion, update.version);
  assert.equal(failed.manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
});

test('an invalid update version never becomes a manual download URL', async () => {
  const controller = createDesktopUpdaterController({
    adapter: fakeAdapter(fakeUpdate({ version: 'https://evil.invalid/x' })),
    isTauriRuntime: () => true,
  });

  const state = await controller.check();

  assert.equal(state.status, 'available');
  assert.equal(state.manualDownloadUrl, undefined);
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
    manualDownloadUrl: BETA6_MANUAL_UPDATE_URL,
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
  assert.equal(controller.getState().manualDownloadUrl, BETA6_MANUAL_UPDATE_URL);
  assert.equal(
    controller.getState().error,
    'Kordi could not verify this update. Download it manually instead.',
  );

  await controller.retry();
  assert.equal(attempts, 2);
  assert.equal(adapter.checkCalls, 1);
  assert.equal(adapter.relaunchCalls, 1);
});

test('an uninformative install failure uses verified-update fallback copy', async () => {
  const update = fakeUpdate({
    async downloadAndInstall() {
      throw new Error('');
    },
  });
  const controller = createDesktopUpdaterController({
    adapter: fakeAdapter(update),
    isTauriRuntime: () => true,
  });
  await controller.check();

  await assert.rejects(controller.install());

  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().error, 'Unable to install the verified Kordi update.');
});

test('disposing closes the held updater resource', async () => {
  let closeCalls = 0;
  const update = fakeUpdate({ async close() { closeCalls += 1; } });
  const adapter = fakeAdapter(update);
  const controller = createDesktopUpdaterController({ adapter, isTauriRuntime: () => true });
  await controller.check();
  await controller.dispose();
  assert.equal(closeCalls, 1);
  assert.equal(controller.getCheckedUpdate(), null);
});
