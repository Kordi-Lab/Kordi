import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  cloudAccountsEqual,
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

test('cloud shell shares the authenticated session instead of bootstrapping nested copies', () => {
  const appRoot = readFileSync(new URL('../src/KordiApp.tsx', import.meta.url), 'utf8');
  const sidebarSlot = readFileSync(new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url), 'utf8');
  const mainContentSwitch = readFileSync(new URL('../src/app/MainContentSwitch.tsx', import.meta.url), 'utf8');

  assert.match(appRoot, /<KordiAppShell\s+cloudSession=\{cloudSessionOverride === undefined \? liveSession : undefined\}/);
  assert.doesNotMatch(sidebarSlot, /useCloudSession\s*\(/);
  assert.doesNotMatch(mainContentSwitch, /useCloudSession\s*\(/);
});

test('profile update websocket subjects target the signed-in account session', () => {
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.account.profile.updated.acct_1', 'acct_1'), true);
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.account.profile.updated.acct_2', 'acct_1'), false);
  assert.equal(shouldRefreshCloudSessionProfileForWsSubject('kordi.events.contact.request.acct_1', 'acct_1'), false);
});

test('cloud account refresh equality ignores object identity but detects visible changes', () => {
  const account = {
    accountId: 'acct_1',
    kordiId: '123456789',
    displayName: 'Name',
    primaryEmail: 'name@example.com',
    avatarUrl: null,
    avatar: {
      entityType: 'human',
      entityId: 'acct_1',
      source: 'generated' as const,
      style: 'lorelei' as const,
      seed: 'account_seed',
      rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
      uploadedAsset: null,
      version: 1,
      updatedAt: '2026-08-19T00:00:00Z',
    },
    defaultAgent: {
      agentId: 'cloud-agent:acct_1',
      displayName: 'Kordi',
      avatarUrl: null,
      avatar: {
        entityType: 'agent',
        entityId: 'cloud-agent:acct_1',
        source: 'generated' as const,
        style: 'bottts-neutral' as const,
        seed: 'agent_seed',
        rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
        uploadedAsset: null,
        version: 1,
        updatedAt: '2026-08-19T00:00:00Z',
      },
    },
    nodeId: 'node_1',
    passwordSet: true,
  };

  assert.equal(cloudAccountsEqual(account, { ...account }), true);
  assert.equal(cloudAccountsEqual(account, { ...account, kordiId: '987654321' }), false);
  assert.equal(cloudAccountsEqual(account, { ...account, displayName: 'Changed' }), false);
  assert.equal(cloudAccountsEqual(account, {
    ...account,
    avatar: { ...account.avatar, seed: 'another_seed' },
  }), false);
  assert.equal(cloudAccountsEqual(account, {
    ...account,
    defaultAgent: { ...account.defaultAgent, displayName: 'Renamed agent' },
  }), false);
  assert.equal(cloudAccountsEqual(account, {
    ...account,
    defaultAgent: {
      ...account.defaultAgent,
      avatar: { ...account.defaultAgent.avatar, seed: 'another_agent_seed' },
    },
  }), false);
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
