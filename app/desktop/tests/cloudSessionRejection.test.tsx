import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { endRejectedCloudSession, isCloudSessionRejected } from '../src/features/cloud/cloudSessionRejection';
import {
  __setSessionBackendForTests,
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';
import {
  DESKTOP_READINESS_INTERVAL_MS,
  DESKTOP_READINESS_MAX_RETRY_MS,
  desktopReadinessRetryDelayMs,
  useDesktopAgentReadiness,
} from '../src/features/cloud/useDesktopAgentReadiness';

const rejected = () => new CloudAuthError('invalid_session', 'Session is expired or revoked.', 401);
const offline = () => new CloudAuthError('network_error', 'Network request failed.', 0);

function memoryBackend(initial: StoredSession | null, refresh?: SessionStorageBackend['refresh']) {
  const state = { session: initial, clears: 0 };
  const backend: SessionStorageBackend = {
    load: async () => state.session,
    save: async (session) => { state.session = session; },
    clear: async () => { state.clears += 1; state.session = null; },
    ...(refresh ? { refresh } : {}),
  };
  return { state, backend };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
}

async function withWindow<T>(run: (dom: JSDOM, signedOut: () => number) => Promise<T>, { native = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  // Readiness belongs to the Mac app, which is detected by Tauri's internals.
  if (native) Object.assign(dom.window, { __TAURI_INTERNALS__: {} });
  const replacements = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let signedOut = 0;
  dom.window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => { signedOut += 1; });
  try {
    return await run(dom, () => signedOut);
  } finally {
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function readinessProbe(client: CloudAuthClient, warnings: string[]) {
  const reportWarning = (message: string) => { warnings.push(message); };
  return function Probe() {
    useDesktopAgentReadiness({ account: { accountId: 'acct_test' } as CloudAccount, client, reportWarning });
    return null;
  };
}

test('only an invalid_session 401 counts as a rejected session', () => {
  assert.equal(isCloudSessionRejected(rejected()), true);
  assert.equal(isCloudSessionRejected(offline()), false);
  assert.equal(isCloudSessionRejected(new CloudAuthError('server_error', 'Could not validate session.', 500)), false);
  assert.equal(isCloudSessionRejected(new CloudAuthError('rate_limited', 'Slow down.', 429)), false);
  assert.equal(isCloudSessionRejected(new CloudAuthError('requester_mismatch', 'No.', 401)), false);
  assert.equal(isCloudSessionRejected(new Error('Session is expired or revoked.')), false);
});

test('readiness retries back off and honor Retry-After', () => {
  assert.equal(desktopReadinessRetryDelayMs(1), DESKTOP_READINESS_INTERVAL_MS);
  assert.equal(desktopReadinessRetryDelayMs(2), 2 * DESKTOP_READINESS_INTERVAL_MS);
  assert.equal(desktopReadinessRetryDelayMs(3), 4 * DESKTOP_READINESS_INTERVAL_MS);
  assert.equal(desktopReadinessRetryDelayMs(30), DESKTOP_READINESS_MAX_RETRY_MS);
  assert.equal(desktopReadinessRetryDelayMs(1, new CloudAuthError('rate_limited', 'Slow down.', 429, 90)), 90_000);
});

test('a rejected session is cleared and signed out once, however many checks report it', async () => {
  await withWindow(async (_dom, signedOut) => {
    const { state, backend } = memoryBackend({ accountId: 'acct_test', token: 'expired', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    const results = await Promise.all([endRejectedCloudSession('expired'), endRejectedCloudSession('expired'), endRejectedCloudSession('expired')]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(state.clears, 1);
    assert.equal(state.session, null);
    assert.equal(signedOut(), 1);
  });
});

test('a session that changed since the failed request is left alone', async () => {
  await withWindow(async (_dom, signedOut) => {
    const { state, backend } = memoryBackend({ accountId: 'acct_test', token: 'fresh', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    assert.equal(await endRejectedCloudSession('expired'), false);
    assert.equal(state.clears, 0);
    assert.equal(signedOut(), 0);
  });
});

test('a browser sign-in refreshes before giving up and signs out when the refresh token is refused', async () => {
  await withWindow(async (_dom, signedOut) => {
    const refreshed = memoryBackend(
      { accountId: 'acct_test', token: 'expired', refreshToken: 'rt', expiresAt: '2099-01-01' },
      async (session) => ({ ...session, token: 'renewed' }),
    );
    __setSessionBackendForTests(refreshed.backend);
    assert.equal(await endRejectedCloudSession('expired'), false);
    assert.equal(refreshed.state.clears, 0);
    assert.equal(signedOut(), 0);

    const refused = memoryBackend(
      { accountId: 'acct_test', token: 'expired', refreshToken: 'rt', expiresAt: '2099-01-01' },
      async () => { throw new Error('invalid_grant'); },
    );
    __setSessionBackendForTests(refused.backend);
    assert.equal(await endRejectedCloudSession('expired'), true);
    assert.equal(refused.state.clears, 1);
    assert.equal(signedOut(), 1);
  });
});

test('readiness stops after an expired or revoked session instead of retrying every interval', async () => {
  await withWindow(async (dom, signedOut) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { state, backend } = memoryBackend({ accountId: 'acct_test', token: 'expired', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    const client = new CloudAuthClient('http://localhost');
    let requests = 0;
    client.desktopAgentExecution = async () => { requests += 1; throw rejected(); };
    const warnings: string[] = [];
    const Probe = readinessProbe(client, warnings);
    const root = createRoot(dom.window.document.getElementById('root')!);
    try {
      await act(async () => root.render(<Probe />));
      await flush();
      assert.equal(requests, 1);
      assert.equal(state.clears, 1);
      assert.equal(signedOut(), 1);
      for (let i = 0; i < 30; i += 1) {
        mock.timers.tick(DESKTOP_READINESS_MAX_RETRY_MS);
        await flush();
      }
      assert.equal(requests, 1, 'A rejected session must not be retried until the person signs in again');
      assert.equal(signedOut(), 1);
      assert.deepEqual(warnings, ['[desktop-runtime] readiness stopped: session rejected']);
    } finally {
      await act(async () => root.unmount());
      mock.timers.reset();
    }
  }, { native: true });
});

test('readiness keeps the session and backs off while the server cannot be reached', async () => {
  await withWindow(async (dom, signedOut) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { state, backend } = memoryBackend({ accountId: 'acct_test', token: 'valid', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    const client = new CloudAuthClient('http://localhost');
    let requests = 0;
    let online = false;
    client.desktopAgentExecution = async <T,>(): Promise<T> => {
      requests += 1;
      if (!online) throw offline();
      return {} as T;
    };
    const Probe = readinessProbe(client, []);
    const root = createRoot(dom.window.document.getElementById('root')!);
    const advance = async (ms: number) => { mock.timers.tick(ms); await flush(); };
    try {
      await act(async () => root.render(<Probe />));
      await flush();
      assert.equal(requests, 1);
      await advance(DESKTOP_READINESS_INTERVAL_MS - 1);
      assert.equal(requests, 1);
      await advance(1);
      assert.equal(requests, 2);
      await advance(2 * DESKTOP_READINESS_INTERVAL_MS - 1);
      assert.equal(requests, 2, 'The second retry waits twice as long');
      await advance(1);
      assert.equal(requests, 3);
      online = true;
      await advance(4 * DESKTOP_READINESS_INTERVAL_MS);
      assert.equal(requests, 4);
      await advance(DESKTOP_READINESS_INTERVAL_MS);
      assert.equal(requests, 5, 'A success returns to the normal interval');
      assert.equal(state.clears, 0);
      assert.equal(signedOut(), 0);
    } finally {
      await act(async () => root.unmount());
      mock.timers.reset();
    }
  }, { native: true });
});

test('the browser app never announces desktop readiness', async () => {
  await withWindow(async (dom) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { backend } = memoryBackend({ accountId: 'acct_test', token: 'live', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    const client = new CloudAuthClient('http://localhost');
    let requests = 0;
    client.desktopAgentExecution = async () => { requests += 1; };
    const warnings: string[] = [];
    const Probe = readinessProbe(client, warnings);
    const root = createRoot(dom.window.document.getElementById('root')!);
    try {
      await act(async () => root.render(<Probe />));
      await flush();
      mock.timers.tick(DESKTOP_READINESS_MAX_RETRY_MS);
      await flush();
      assert.equal(requests, 0);
      assert.deepEqual(warnings, []);
    } finally {
      await act(async () => root.unmount());
      mock.timers.reset();
    }
  });
});
