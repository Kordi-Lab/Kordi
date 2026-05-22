import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudAuthResult } from '../src/features/cloud/authClient';
import { completeCloudAuthResult } from '../src/features/cloud/useCloudSession';

const account = (accountId: string): CloudAccount => ({
  accountId,
  displayName: 'Cloud User',
  primaryEmail: `${accountId}@example.test`,
  avatarUrl: null,
  nodeId: null,
  passwordSet: true,
});

const resultFor = (accountId: string): CloudAuthResult => ({
  account: account(accountId),
  session: {
    token: `token-${accountId}`,
    expiresAt: '2099-01-01T00:00:00Z',
  },
});

test('completeCloudAuthResult activates account storage before publishing authenticated state', async () => {
  const order: string[] = [];
  const result = resultFor('acct_alpha');

  const completed = await completeCloudAuthResult({
    result,
    currentAccountId: null,
    saveSession: async (session) => {
      order.push(`save:${session.accountId}`);
    },
    activateAccountStorage: async (accountId) => {
      order.push(`activate:${accountId}`);
      return { accountId, storageRoot: `/tmp/${accountId}/kordi`, requiresReload: false };
    },
    publishRuntimeOnline: async (token) => {
      order.push(`runtime:${token}`);
    },
    setAuthenticated: (next) => {
      order.push(`auth:${next.accountId}`);
    },
    registerDevice: async ({ accountId }) => {
      order.push(`device:${accountId}`);
    },
    reloadWindow: () => {
      order.push('reload');
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(order, [
    'save:acct_alpha',
    'runtime:token-acct_alpha',
    'activate:acct_alpha',
    'auth:acct_alpha',
    'device:acct_alpha',
  ]);
});

test('completeCloudAuthResult reloads instead of publishing when native account activation crosses accounts', async () => {
  const order: string[] = [];
  const result = resultFor('acct_beta');

  const completed = await completeCloudAuthResult({
    result,
    currentAccountId: 'acct_alpha',
    saveSession: async (session) => {
      order.push(`save:${session.accountId}`);
    },
    activateAccountStorage: async (accountId) => {
      order.push(`activate:${accountId}`);
      return { accountId, storageRoot: `/tmp/${accountId}/kordi`, requiresReload: true };
    },
    publishRuntimeOnline: async (token) => {
      order.push(`runtime:${token}`);
    },
    setAuthenticated: (next) => {
      order.push(`auth:${next.accountId}`);
    },
    registerDevice: async ({ accountId }) => {
      order.push(`device:${accountId}`);
    },
    reloadWindow: () => {
      order.push('reload');
    },
  });

  assert.equal(completed, false);
  assert.deepEqual(order, ['save:acct_beta', 'runtime:token-acct_beta', 'activate:acct_beta', 'reload']);
});

test('completeCloudAuthResult continues login if early runtime status publish fails', async () => {
  const order: string[] = [];
  const result = resultFor('acct_gamma');

  const completed = await completeCloudAuthResult({
    result,
    currentAccountId: null,
    saveSession: async (session) => {
      order.push(`save:${session.accountId}`);
    },
    publishRuntimeOnline: async (token) => {
      order.push(`runtime:${token}`);
      throw new Error('runtime unavailable');
    },
    activateAccountStorage: async (accountId) => {
      order.push(`activate:${accountId}`);
      return { accountId, storageRoot: `/tmp/${accountId}/kordi`, requiresReload: false };
    },
    setAuthenticated: (next) => {
      order.push(`auth:${next.accountId}`);
    },
    registerDevice: async ({ accountId }) => {
      order.push(`device:${accountId}`);
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(order, [
    'save:acct_gamma',
    'runtime:token-acct_gamma',
    'activate:acct_gamma',
    'auth:acct_gamma',
    'device:acct_gamma',
  ]);
});
