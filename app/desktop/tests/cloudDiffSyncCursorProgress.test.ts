import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadCloudSyncCursor,
  saveCloudSyncCursor,
  syncCloudDiffOnce,
} from '../src/features/cloud/cloudDiffSync';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

test('syncCloudDiffOnce rejects a non-advancing cursor while more pages remain', async () => {
  const storage = memoryStorage();
  saveCloudSyncCursor('acct_me', '42', storage);

  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    fetchEvents: async () => ({ cursor: '42', hasMore: true, events: [] }),
  });

  assert.equal(result.fallbackRequired, true);
  assert.equal(loadCloudSyncCursor('acct_me', storage), '42');
});
