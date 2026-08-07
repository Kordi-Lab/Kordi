import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCloudProfileRows } from '../src/pages/WorkspaceSidebar';
import type { CloudAccount } from '../src/features/cloud/authClient';

const account: CloudAccount = {
  accountId: 'acct_50a66b83799045',
  kordiId: '482731906',
  displayName: 'Shuyheretest',
  primaryEmail: 'shu@example.com',
  avatarUrl: 'data:image/jpeg;base64,profile',
  nodeId: 'node_9c2abc',
  passwordSet: true,
};

test('cloud profile helpers expose only the public Kordi ID', () => {
  const rows = buildCloudProfileRows(account);
  assert.deepEqual(rows.map((row) => row.label), ['Kordi ID']);
  assert.equal(rows[0]?.value, '@482731906');
  assert.equal(rows.some((row) => row.label === 'Device'), false);
  assert.equal(rows.some((row) => row.label === 'Avatar'), false);
  assert.equal(rows.some((row) => row.label === 'Email'), false);
});

test('cloud profile helpers do not fall back to a canonical account id', () => {
  const rows = buildCloudProfileRows({ ...account, kordiId: null });
  assert.deepEqual(rows, []);
});
