import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCloudProfileRows } from '../src/pages/WorkspaceSidebar';
import type { CloudAccount } from '../src/features/cloud/authClient';

const account: CloudAccount = {
  accountId: 'acct_50a66b83799045',
  displayName: 'Shuyheretest',
  primaryEmail: 'shu@example.com',
  avatarUrl: 'data:image/jpeg;base64,profile',
  nodeId: 'node_9c2abc',
  passwordSet: true,
};

test('cloud profile menu shows personal account rows without device or avatar storage rows', () => {
  const rows = buildCloudProfileRows(account);
  assert.deepEqual(rows.map((row) => row.label), ['Email', 'Account ID']);
  assert.equal(rows.find((row) => row.label === 'Email')?.value, 'shu@example.com');
  assert.equal(rows.find((row) => row.label === 'Account ID')?.value, 'acct_50a66b83799045');
  assert.equal(rows.some((row) => row.label === 'Device'), false);
  assert.equal(rows.some((row) => row.label === 'Avatar'), false);
});

test('cloud profile menu falls back when optional personal info is missing', () => {
  const rows = buildCloudProfileRows({ ...account, primaryEmail: null });
  assert.deepEqual(rows.map((row) => row.label), ['Account ID']);
});
