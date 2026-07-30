import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAuthorizedCloudGroupSessionTitleSnapshot, resolveCloudGroupAdminSnapshot } from '../src/features/cloud/useCloudCollaborationState';

test('replicated admin snapshots preserve creator authority and reject admin or stale updates', () => {
  const identityIdByAccount = new Map([
    ['acct_creator', 'human:creator'],
    ['acct_alice', 'human:alice'],
  ]);
  const adminEnvelope = {
    kind: 'group-update' as const,
    actor: { accountId: 'acct_alice', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    createdByAccountId: 'acct_creator',
    participants: [
      { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_alice', displayName: 'Alice', avatarUrl: null, role: 'person' },
    ],
  };
  const unauthorizedAdmin = resolveCloudGroupAdminSnapshot({
    envelope: adminEnvelope,
    identityIdByAccount,
    createdByIdentityId: 'human:creator',
    existingAdminIdentityIds: ['human:creator', 'human:alice'],
    hasExistingSession: true,
    controlCreatedAtMs: 20,
    storedAdminUpdatedAtMs: 10,
  });
  assert.equal(unauthorizedAdmin.applies, false);
  assert.deepEqual(unauthorizedAdmin.adminIdentityIds, ['human:creator', 'human:alice']);

  const creatorEnvelope = {
    ...adminEnvelope,
    actor: { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
  };
  const current = resolveCloudGroupAdminSnapshot({
    envelope: creatorEnvelope,
    identityIdByAccount,
    createdByIdentityId: 'human:creator',
    existingAdminIdentityIds: ['human:creator', 'human:alice'],
    hasExistingSession: true,
    controlCreatedAtMs: 20,
    storedAdminUpdatedAtMs: 10,
  });
  assert.equal(current.applies, true);
  assert.deepEqual(current.adminIdentityIds, ['human:creator']);

  const stale = resolveCloudGroupAdminSnapshot({
    envelope: creatorEnvelope,
    identityIdByAccount,
    createdByIdentityId: 'human:creator',
    existingAdminIdentityIds: ['human:creator', 'human:alice'],
    hasExistingSession: true,
    controlCreatedAtMs: 5,
    storedAdminUpdatedAtMs: 10,
  });
  assert.equal(stale.applies, false);
  assert.deepEqual(stale.adminIdentityIds, ['human:creator', 'human:alice']);
});

test('session title snapshots may be relayed by a member but only an administrator may author them', () => {
  const identityIdByAccount = new Map([
    ['acct_admin', 'human:admin'],
    ['acct_member', 'human:member'],
  ]);
  const envelope = {
    kind: 'session-title-update' as const,
    groupTitle: 'main',
    actor: { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    sessionTitle: {
      title: 'main',
      titleSource: 'manual' as const,
      titleRevision: 2,
      titlePolicyVersion: 1,
      updatedAtMs: 1_000,
      updatedByAccountId: 'acct_admin',
    },
  };

  assert.equal(resolveAuthorizedCloudGroupSessionTitleSnapshot({
    envelope,
    controlCreatedAtMs: 2_000,
    identityIdByAccount,
    adminIdentityIds: ['human:admin'],
  })?.title, 'main');

  assert.equal(resolveAuthorizedCloudGroupSessionTitleSnapshot({
    envelope: {
      ...envelope,
      sessionTitle: { ...envelope.sessionTitle, updatedByAccountId: 'acct_member' },
    },
    controlCreatedAtMs: 2_000,
    identityIdByAccount,
    adminIdentityIds: ['human:admin'],
  }), null);
});
