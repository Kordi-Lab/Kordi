import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  __setSessionBackendForTests,
  clearSession,
  clearSessionAndNotifySignedOut,
  loadSession,
  saveSession,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';
import {
  applyCloudSessionProfileUpdate,
  shouldRefreshCloudSessionProfileForWsSubject,
} from '../src/features/cloud/useCloudSession';

class FakeBackend implements SessionStorageBackend {
  cached: StoredSession | null = null;
  loadCount = 0;
  saveCount = 0;
  clearCount = 0;

  async load() {
    this.loadCount += 1;
    return this.cached;
  }
  async save(session: StoredSession) {
    this.saveCount += 1;
    this.cached = { ...session };
  }
  async clear() {
    this.clearCount += 1;
    this.cached = null;
  }
}

test('load/save/clear round-trip through the injected backend', async () => {
  const fake = new FakeBackend();
  __setSessionBackendForTests(fake);
  try {
    assert.equal(await loadSession(), null);
    await saveSession({
      token: 'kordi_cs_abc',
      accountId: 'acct_1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    assert.equal(fake.saveCount, 1);
    const got = await loadSession();
    assert.deepEqual(got, {
      token: 'kordi_cs_abc',
      accountId: 'acct_1',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    await clearSession();
    assert.equal(fake.clearCount, 1);
    assert.equal(await loadSession(), null);
  } finally {
    __setSessionBackendForTests(null);
  }
});

test('memory fallback (no backend override, no Tauri) survives within a process', async () => {
  __setSessionBackendForTests(null);
  // No __TAURI_INTERNALS__ in the node test env, so the module picks the
  // in-memory backend automatically. Patch console.warn to avoid noise.
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await clearSession();
    assert.equal(await loadSession(), null);
    await saveSession({
      token: 'kordi_cs_xyz',
      accountId: 'acct_2',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const got = await loadSession();
    assert.equal(got?.token, 'kordi_cs_xyz');
    await clearSession();
    assert.equal(await loadSession(), null);
  } finally {
    console.warn = originalWarn;
  }
});

test('profile update websocket subjects target the signed-in account session', () => {
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.account.profile.updated.acct_1', 'acct_1'), true);
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.account.profile.updated.acct_2', 'acct_1'), false);
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.contact.request.acct_1', 'acct_1'), false);
});

test('profile update payload patches the current cloud session account', () => {
  const account = {
    accountId: 'acct_1',
    displayName: 'Old name',
    primaryEmail: 'old@example.com',
    avatarUrl: 'data:image/png;base64,old',
    nodeId: 'node_1',
    passwordSet: true,
  };

  assert.deepEqual(applyCloudSessionProfileUpdate(account, {
    account_id: 'acct_1',
    display_name: 'New name',
    avatar_url: 'data:image/png;base64,new',
  }), {
    ...account,
    displayName: 'New name',
    avatarUrl: 'data:image/png;base64,new',
  });
  assert.equal(applyCloudSessionProfileUpdate(account, { account_id: 'acct_2', display_name: 'Other' }), null);
});

test('clearSessionAndNotifySignedOut clears storage and broadcasts logout for other Cloud session hooks', async () => {
  const fake = new FakeBackend();
  __setSessionBackendForTests(fake);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  let eventCount = 0;
  fakeWindow.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => {
    eventCount += 1;
  });
  try {
    await saveSession({
      token: 'kordi_cs_logout',
      accountId: 'acct_logout',
      expiresAt: '2099-01-01T00:00:00Z',
    });

    await clearSessionAndNotifySignedOut();

    assert.equal(fake.clearCount, 1);
    assert.equal(await loadSession(), null);
    assert.equal(eventCount, 1);
  } finally {
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
