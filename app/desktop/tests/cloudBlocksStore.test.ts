import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import {
  __resetCloudBlocksForTests,
  cloudBlocksSnapshot,
  currentBlockedIdentityIds,
  forgetBlockedAccount,
  refreshCloudBlocks,
  rememberBlockedAccount,
  safetyFeaturesAvailableFor,
} from '../src/features/safety/useCloudBlocks';

const block = (accountId: string) => ({
  accountId,
  kordiId: '482731906',
  displayName: accountId,
  avatarUrl: null,
  blockedAt: '2026-10-01T00:00:00Z',
});

function clientAnswering(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      urls.push(String(input));
      return respond(String(input));
    },
  });
  return { client, urls };
}

beforeEach(() => {
  __resetCloudBlocksForTests();
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_a', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
});

afterEach(() => {
  __setSessionBackendForTests(null);
  __resetCloudBlocksForTests();
});

test('a server without the blocks route marks safety actions unavailable and touches nothing else', async () => {
  const { client, urls } = clientAnswering(() => new Response('', { status: 404 }));

  await refreshCloudBlocks('acct_a', client);

  assert.deepEqual(cloudBlocksSnapshot('acct_a'), { blocks: [], loaded: true, available: false, error: null });
  assert.equal(safetyFeaturesAvailableFor('acct_a'), false);
  // Only the blocks list is requested: a contacts refresh is never part of
  // this store, so an older server cannot break it.
  assert.deepEqual(urls, ['http://srv/v1/cloud/blocks']);
});

test('the blocks list makes safety actions available and exposes blocked identities', async () => {
  const { client } = clientAnswering(() => Response.json({ blocks: [block('acct_b')] }));

  assert.equal(safetyFeaturesAvailableFor('acct_a'), false, 'unknown until the first answer');
  await refreshCloudBlocks('acct_a', client);

  assert.equal(safetyFeaturesAvailableFor('acct_a'), true);
  assert.deepEqual([...currentBlockedIdentityIds('acct_a')], ['human:acct_b']);

  rememberBlockedAccount('acct_a', block('acct_c'));
  assert.deepEqual([...currentBlockedIdentityIds('acct_a')].sort(), ['human:acct_b', 'human:acct_c']);
  forgetBlockedAccount('acct_a', 'acct_b');
  assert.deepEqual([...currentBlockedIdentityIds('acct_a')], ['human:acct_c']);
  assert.deepEqual([...currentBlockedIdentityIds('acct_other')], []);
});

test('an error with a code or a network failure keeps the known availability', async () => {
  const ok = clientAnswering(() => Response.json({ blocks: [block('acct_b')] }));
  await refreshCloudBlocks('acct_a', ok.client);

  const coded = clientAnswering(() => Response.json({ errorCode: 'invalid_session', message: 'Sign in again.' }, { status: 404 }));
  await refreshCloudBlocks('acct_a', coded.client);
  assert.equal(cloudBlocksSnapshot('acct_a').available, true);
  assert.equal(cloudBlocksSnapshot('acct_a').error, 'Sign in again.');
  assert.deepEqual(cloudBlocksSnapshot('acct_a').blocks.map((item) => item.accountId), ['acct_b']);

  const offline = clientAnswering(() => { throw new TypeError('offline'); });
  await refreshCloudBlocks('acct_a', offline.client);
  assert.equal(safetyFeaturesAvailableFor('acct_a'), true);
  assert.equal(cloudBlocksSnapshot('acct_a').error, 'offline');
});

test('a failed first load leaves safety actions hidden', async () => {
  const offline = clientAnswering(() => { throw new TypeError('offline'); });
  await refreshCloudBlocks('acct_a', offline.client);
  assert.equal(cloudBlocksSnapshot('acct_a').loaded, false);
  assert.equal(safetyFeaturesAvailableFor('acct_a'), false);
});

test('a refresh for another signed-in account changes nothing', async () => {
  const { client, urls } = clientAnswering(() => Response.json({ blocks: [block('acct_b')] }));
  await refreshCloudBlocks('acct_someone_else', client);
  assert.deepEqual(urls, []);
  assert.equal(cloudBlocksSnapshot('acct_someone_else').loaded, false);
});
