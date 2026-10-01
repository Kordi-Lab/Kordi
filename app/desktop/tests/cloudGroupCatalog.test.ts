import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupCatalogRow } from '../src/features/cloud/cloudGroupCatalog';
import { cloudGroupMemberJoinNoticeRequests, cloudSessionTitleUpdateNoticeRequest } from '../src/features/cloud/cloudGroupMessages';
import { conversation as fixture } from './helpers/chatSyncCanonicalFixtures';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';

const group: ChatSyncConversation = {
  ...fixture,
  kind: 'group',
  legacy_session_id: 'session:group:channel',
  group_space_id: 'session:group:root',
  group_title: 'Research team',
  shared_title: 'Planning',
  latest_message_sequence: 0,
};

test('catalog recovery preserves group, channel, title, and active member identity without a chat message', () => {
  const row = cloudGroupCatalogRow({
    ...group,
    members: [...group.members, { ...group.members[0], account_id: 'acct_left', membership_state: 'left' }],
  }, 'acct_b');
  assert.ok(row);
  assert.equal(row.envelope.groupId, 'session:group:channel');
  assert.equal(row.envelope.groupSpaceId, 'session:group:root');
  assert.equal(row.envelope.groupTitle, 'Research team');
  assert.equal(row.envelope.sessionTitle?.title, 'Planning');
  assert.equal(row.envelope.message, undefined);
  assert.deepEqual(row.envelope.participants.map(member => member.accountId), ['acct_a', 'acct_b']);
  assert.equal(cloudSessionTitleUpdateNoticeRequest({
    envelope: row.envelope, actorIdentityId: 'human:acct_a',
    createdAtMs: Date.parse(row.wire.createdAt), cloudMessageId: row.wire.messageId,
  }), null);
  assert.deepEqual(cloudGroupMemberJoinNoticeRequests({
    envelope: row.envelope, actorIdentityId: 'human:acct_a',
    identityIdByAccount: new Map(), existingMessageIds: new Set(),
  }), []);
});

test('catalog recovery does not restore groups for departed members or non-group conversations', () => {
  assert.equal(cloudGroupCatalogRow(fixture, 'acct_b'), null);
  assert.equal(cloudGroupCatalogRow(group, 'acct_other'), null);
  assert.equal(cloudGroupCatalogRow({
    ...group, members: group.members.map(member => ({ ...member, membership_state: 'left' })),
  }, 'acct_b'), null);
});
