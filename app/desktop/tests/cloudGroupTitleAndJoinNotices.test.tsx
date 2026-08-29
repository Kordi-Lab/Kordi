import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupMemberJoinNoticeRequests, cloudGroupSessionTitleSnapshotForControl, encodeCloudGroupControl, parseCloudGroupControl, cloudGroupTitleUpdateNoticeRequest, cloudSessionTitleUpdateNoticeRequest } from '../src/features/cloud/cloudGroupMessages';
import { legacyCloudGroupTitleNoticeClassifications } from '../src/features/cloud/legacyCloudGroupTitleNotices';
import { cloudGroupHistoryReplayPreservesSessionShell } from '../src/features/cloud/cloudGroupSessionControl';

test('history replay preserves an existing group session shell', () => {
  assert.equal(cloudGroupHistoryReplayPreservesSessionShell(true, true), true);
  assert.equal(cloudGroupHistoryReplayPreservesSessionShell(true, false), false);
  assert.equal(cloudGroupHistoryReplayPreservesSessionShell(false, true), false);
});

test('legacy session rename controls become administrator-authored title snapshots', () => {
  const snapshot = cloudGroupSessionTitleSnapshotForControl({
    kind: 'session-title-update',
    groupTitle: 'main',
    actor: { accountId: 'acct_admin', displayName: 'Admin', avatarUrl: null, role: 'admin' },
    sessionTitle: null,
  }, 1_234);

  assert.deepEqual(snapshot, {
    title: 'main',
    titleSource: 'manual',
    titleRevision: 1,
    titlePolicyVersion: 1,
    updatedAtMs: 1_234,
    updatedByAccountId: 'acct_admin',
  });
});

test('automatic session title backfills stay silent while applying the same snapshot', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'session-title-update',
    groupId: 'session:group:title-backfill',
    groupSpaceId: 'session:group:title-backfill',
    groupTitle: 'main',
    createdByAccountId: 'acct_admin',
    actor: { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_admin', displayName: 'Admin', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    ],
    sessionTitle: {
      title: 'main',
      titleSource: 'manual',
      titleRevision: 2,
      titlePolicyVersion: 1,
      updatedAtMs: 1_234,
      updatedByAccountId: 'acct_admin',
    },
    sessionTitleSyncOnly: true,
    message: null,
  }));

  assert.equal(envelope?.sessionTitleSyncOnly, true);
  assert.equal(cloudSessionTitleUpdateNoticeRequest({
    envelope: envelope!,
    actorIdentityId: 'human:acct_member',
    createdAtMs: 2_000,
    cloudMessageId: 'cloud-title-backfill',
  }), null);
});

test('group title updates build a remote visible group rename notice separately from session titles', () => {
  const request = cloudGroupTitleUpdateNoticeRequest({
    envelope: {
      kind: 'group-title-update',
      groupId: 'session:group:cloud',
      groupSpaceId: 'space:cloud',
      groupTitle: 'Good group',
      createdByAccountId: 'acct_sender',
      actor: { accountId: 'acct_sender', displayName: 'Álvaro', avatarUrl: null },
      participants: [{ accountId: 'acct_sender', displayName: 'Álvaro', avatarUrl: null }],
      message: null,
    },
    actorIdentityId: 'human:cloud:acct_sender',
    createdAtMs: 1234,
    cloudMessageId: 'cloud-msg-group-rename',
  });

  assert.equal(request?.id, 'cloud-group-title-notice:cloud-msg-group-rename');
  assert.equal(request?.sessionId, 'session:group:cloud');
  assert.equal(request?.contentText, 'Álvaro changed the group name to Good group');
  assert.deepEqual(request?.content, {
    kind: 'group-title-update',
    scope: 'group',
    title: 'Good group',
    actorDisplayName: 'Álvaro',
    sourceControlKind: 'group-title-update',
  });
});

test('group invites and membership updates never synthesize rename notices', () => {
  for (const kind of ['group-invite', 'group-update'] as const) {
    assert.equal(cloudGroupTitleUpdateNoticeRequest({
      envelope: {
        kind,
        groupId: 'session:group:cloud',
        groupSpaceId: 'session:group:cloud',
        groupTitle: 'Ethan Park, Alex Morgan',
        createdByAccountId: 'acct_maya',
        actor: { accountId: 'acct_maya', displayName: 'Maya Chen', avatarUrl: null },
        participants: [{ accountId: 'acct_maya', displayName: 'Maya Chen', avatarUrl: null }],
        message: null,
      },
      actorIdentityId: 'human:cloud:acct_maya',
      createdAtMs: 1_234,
      cloudMessageId: `cloud-${kind}`,
    }), null);
  }
});

test('historical notices classify exact recovered controls after cache loss', () => {
  const body = (kind: 'group-invite' | 'group-title-update') => encodeCloudGroupControl({
    kind,
    groupId: 'session:group:cloud',
    groupSpaceId: 'session:group:cloud',
    groupTitle: 'Ethan Park, Alex Morgan',
    createdByAccountId: 'acct_maya',
    actor: { accountId: 'acct_maya', displayName: 'Maya Chen', avatarUrl: null },
    participants: [{ accountId: 'acct_maya', displayName: 'Maya Chen', avatarUrl: null }],
    message: null,
  });
  assert.deepEqual(legacyCloudGroupTitleNoticeClassifications(
    ['older-than-window', 'real-rename', 'missing'],
    [
      { messageId: 'older-than-window', body: body('group-invite') },
      { messageId: 'real-rename', body: body('group-title-update') },
    ],
  ), [
    { cloudMessageId: 'older-than-window', sourceControlKind: 'group-invite' },
    { cloudMessageId: 'real-rename', sourceControlKind: 'group-title-update' },
  ]);
});

test('session title updates build a remote visible rename notice without changing group metadata', () => {
  const request = cloudSessionTitleUpdateNoticeRequest({
    envelope: {
      kind: 'session-title-update',
      groupId: 'session:group:cloud',
      groupSpaceId: 'space:cloud',
      groupTitle: 'Sprint follow-up',
      createdByAccountId: 'acct_sender',
      actor: { accountId: 'acct_sender', displayName: 'Álvaro', avatarUrl: null },
      participants: [{ accountId: 'acct_sender', displayName: 'Álvaro', avatarUrl: null }],
      message: null,
    },
    actorIdentityId: 'human:cloud:acct_sender',
    createdAtMs: 1234,
    cloudMessageId: 'cloud-msg-rename',
  });

  assert.equal(request?.id, 'cloud-session-title-notice:cloud-msg-rename');
  assert.equal(request?.sessionId, 'session:group:cloud');
  assert.equal(request?.senderRole, 'system');
  assert.equal(request?.messageKind, 'status');
  assert.equal(request?.contentText, 'Álvaro changed the session name to Sprint follow-up');
  assert.deepEqual(request?.content, {
    kind: 'session-title-update',
    scope: 'session',
    title: 'Sprint follow-up',
    actorDisplayName: 'Álvaro',
  });
});

test('session title notices use the verified title author instead of the relay', () => {
  const request = cloudSessionTitleUpdateNoticeRequest({
    envelope: {
      kind: 'session-title-update',
      groupId: 'session:group:relayed-title',
      groupSpaceId: 'space:cloud',
      groupTitle: 'Sprint follow-up',
      createdByAccountId: 'acct_admin',
      actor: { accountId: 'acct_relay', displayName: 'Relay', avatarUrl: null, role: 'person' },
      participants: [
        { accountId: 'acct_admin', displayName: 'Admin', avatarUrl: null, role: 'admin' },
        { accountId: 'acct_relay', displayName: 'Relay', avatarUrl: null, role: 'person' },
      ],
      sessionTitle: {
        title: 'Sprint follow-up',
        titleSource: 'manual',
        titleRevision: 2,
        titlePolicyVersion: 1,
        updatedAtMs: 1_000,
        updatedByAccountId: 'acct_admin',
      },
      message: null,
    },
    actorIdentityId: 'human:cloud:acct_admin',
    actorDisplayName: 'Admin',
    createdAtMs: 1_234,
    cloudMessageId: 'cloud-msg-relayed-rename',
  });

  assert.equal(request?.senderIdentityId, 'human:cloud:acct_admin');
  assert.equal(request?.contentText, 'Admin changed the session name to Sprint follow-up');
  assert.equal((request?.content as { actorDisplayName?: string }).actorDisplayName, 'Admin');
});

test('group invites carry one durable join notice for each invited member', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-invite',
    groupId: 'session:group:cloud',
    groupSpaceId: 'session:group:root',
    groupTitle: 'Research team',
    createdByAccountId: 'acct_inviter',
    actor: { accountId: 'acct_inviter', displayName: 'Alex Morgan', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_inviter', displayName: 'Alex Morgan', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_new', displayName: 'Maya Chen', avatarUrl: null, role: 'person' },
    ],
    memberJoins: [{
      eventId: 'invite_event_1',
      accountId: 'acct_new',
      displayName: 'Maya Chen',
      createdAtMs: 1234,
    }],
    message: null,
  }));

  assert.deepEqual(envelope?.memberJoins, [{
    eventId: 'invite_event_1',
    accountId: 'acct_new',
    displayName: 'Maya Chen',
    createdAtMs: 1234,
  }]);
  const requests = cloudGroupMemberJoinNoticeRequests({
    envelope: envelope!,
    actorIdentityId: 'human:cloud:acct_inviter',
    identityIdByAccount: new Map([
      ['acct_inviter', 'human:cloud:acct_inviter'],
      ['acct_new', 'human:cloud:acct_new'],
    ]),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.id, 'msg:group-member-join:invite_event_1:session:group:cloud');
  assert.equal(requests[0]?.senderRole, 'system');
  assert.equal(requests[0]?.messageKind, 'status');
  assert.equal(requests[0]?.contentText, 'Maya Chen joined the group, invited by Alex Morgan.');
  assert.deepEqual(requests[0]?.content, {
    kind: 'group-member-joined',
    eventId: 'invite_event_1',
    memberIdentityId: 'human:cloud:acct_new',
    memberDisplayName: 'Maya Chen',
    invitedByIdentityId: 'human:cloud:acct_inviter',
    invitedByDisplayName: 'Alex Morgan',
  });
  assert.deepEqual(cloudGroupMemberJoinNoticeRequests({
    envelope: envelope!,
    actorIdentityId: 'human:cloud:acct_inviter',
    identityIdByAccount: new Map([
      ['acct_inviter', 'human:cloud:acct_inviter'],
      ['acct_new', 'human:cloud:acct_new'],
    ]),
    existingMessageIds: new Set([requests[0]!.id!]),
  }), []);
});
