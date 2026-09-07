import { strict as assert } from 'node:assert';
import test from 'node:test';

import { __setSessionBackendForTests, clearSession, loadSession, saveSession, type SessionStorageBackend, type StoredSession } from '../src/features/cloud/session';

test('a delayed keychain read cannot restore the signed-out or previous account session', async () => {
  let finish!: (value: StoredSession) => void;
  __setSessionBackendForTests({load: () => new Promise(resolve => { finish = resolve; }), save: async () => {}, clear: async () => {}});
  try {
    const pending = loadSession();
    await clearSession();
    const current = {accountId:'acct_new',deviceId:'device_new',token:'synthetic-new',expiresAt:'2099-01-01'};
    await saveSession(current);
    finish({accountId:'acct_old',deviceId:'device_old',token:'synthetic-old',expiresAt:'2099-01-01'});
    assert.deepEqual(await pending, current);
    assert.deepEqual(await loadSession(), current);
  } finally { __setSessionBackendForTests(null); }
});

function countingBackend(session: StoredSession | null) {
  let current = session;
  let loadCount = 0;
  const backend: SessionStorageBackend = {
    async load() {
      loadCount += 1;
      return current;
    },
    async save(next) {
      current = { ...next };
    },
    async clear() {
      current = null;
    },
  };
  return { backend, loadCount: () => loadCount };
}

test('loadSession dedupes concurrent and repeated keychain reads until session changes', async () => {
  const stored: StoredSession = {
    token: 'token_1',
    accountId: 'acct_1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const counter = countingBackend(stored);
  __setSessionBackendForTests(counter.backend);
  try {
    const [first, second, third] = await Promise.all([loadSession(), loadSession(), loadSession()]);
    assert.equal(first?.token, 'token_1');
    assert.equal(second?.token, 'token_1');
    assert.equal(third?.token, 'token_1');
    assert.equal(counter.loadCount(), 1, 'concurrent startup loads should share one backend read');

    const repeated = await loadSession();
    assert.equal(repeated?.token, 'token_1');
    assert.equal(counter.loadCount(), 1, 'repeated loads should reuse cached session');

    await saveSession({ ...stored, token: 'token_2' });
    const saved = await loadSession();
    assert.equal(saved?.token, 'token_2');
    assert.equal(counter.loadCount(), 1, 'saving should update the cache without an extra keychain read');

    await clearSession();
    const cleared = await loadSession();
    assert.equal(cleared, null);
    assert.equal(counter.loadCount(), 1, 'clearing should update the cache without an extra keychain read');
  } finally {
    __setSessionBackendForTests(null);
  }
});
