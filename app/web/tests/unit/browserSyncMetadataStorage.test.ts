import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSyncMetadataStorage } from '@web/runtime/browserSyncMetadataStorage';
import { __setSessionBackendForTests, saveSession, clearSession } from '@/features/cloud/session';

test('browser visibility readiness cannot cross accounts or organizations and clears on signout', async () => {
  const prior = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = new EventTarget();
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  try {
    const storage = browserSyncMetadataStorage();
    assert.equal(storage, browserSyncMetadataStorage());
    await saveSession({ token: 'synthetic', accountId: 'owner', organizationId: 'first' });
    storage.setItem('visibility', 'first-authoritative');
    await saveSession({ token: 'synthetic', accountId: 'owner', organizationId: 'second' });
    assert.equal(storage.getItem('visibility'), null);
    storage.setItem('visibility', 'second-authoritative');
    await saveSession({ token: 'synthetic', accountId: 'other', organizationId: 'second' });
    assert.equal(storage.getItem('visibility'), null);
    storage.setItem('visibility', 'other-authoritative');
    await clearSession();
    await saveSession({ token: 'synthetic', accountId: 'other', organizationId: 'second' });
    assert.equal(storage.getItem('visibility'), null);
    assert.equal(storage.length, 0);
  } finally {
    __setSessionBackendForTests(null);
    if (prior === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prior;
  }
});
