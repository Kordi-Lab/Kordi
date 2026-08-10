import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseCloudOAuthHashError,
  parseCloudOAuthHashResult,
} from '../src/features/cloud/cloudOAuthResult';

test('parseCloudOAuthHashResult decodes auth result fragments', () => {
  const payload = {
    account: {
      accountId: 'acct_1',
      displayName: 'Ada',
      primaryEmail: 'ada@example.com',
      avatarUrl: null,
      nodeId: null,
      passwordSet: false,
    },
    session: { token: 'kordi_cs_abc', expiresAt: '2099-01-01T00:00:00Z' },
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  assert.deepEqual(parseCloudOAuthHashResult(`#kordi_cloud_oauth=${encoded}`), payload);
  assert.equal(parseCloudOAuthHashResult('#not_oauth=1'), null);
});

test('parseCloudOAuthHashError surfaces the provider-safe callback error', () => {
  assert.equal(
    parseCloudOAuthHashError('#kordi_cloud_oauth_error=OAuth%20state%20expired.'),
    'OAuth state expired.',
  );
  assert.equal(parseCloudOAuthHashError('#not_oauth=1'), null);
});
