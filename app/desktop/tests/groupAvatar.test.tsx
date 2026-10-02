import { createElement } from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupAvatar } from '../src/kordi-app/components/GroupAvatar';
import { normalizeGroupAvatarSnapshot, sharedGroupAvatar } from '../src/features/chat/groupAvatar';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudGroupSessionPreparationSignature } from '../src/features/cloud/cloudGroupSessionPolicy';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const image = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';
const actor = { accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null, role: 'admin' as const };
const envelope = { kind: 'group-avatar-update' as const, groupId: 'session:group:a', groupSpaceId: 'shared', createdByAccountId: actor.accountId, actor, participants: [actor] };

test('group images and explicit removals survive transport without embedding image bytes', () => {
  for (const imageUrl of [image, null]) {
    const groupAvatar = { imageUrl, updatedAtMs: 1000 };
    assert.deepEqual(parseCloudGroupControl(encodeCloudGroupControl({ ...envelope, groupAvatar }))?.groupAvatar, groupAvatar);
  }
  assert.equal(normalizeGroupAvatarSnapshot({ imageUrl: 'data:image/png;base64,AA==', updatedAtMs: 1000 }), null);
  assert.equal(normalizeGroupAvatarSnapshot({ imageUrl: 'https://example.test/image.png', updatedAtMs: 1000 }), null);
});

test('a removal wins over older images regardless of channel activity or replay order', () => {
  const old = { imageUrl: image, updatedAtMs: 10 };
  const removal = { imageUrl: null, updatedAtMs: 20 };
  assert.deepEqual(sharedGroupAvatar([old, removal, old]), removal);
  assert.deepEqual(sharedGroupAvatar([removal, old]), removal);
});

test('square collages retain square tiles and cap large groups at nine members', () => {
  const avatars = Array.from({ length: 12 }, (_, i) => ({ kind: 'human' as const, seed: `member-${i}` }));
  const markup = renderToStaticMarkup(createElement(GroupAvatar, { avatars, name: 'Team' }));
  assert.equal((markup.match(/min-h-0 min-w-0/g) ?? []).length, 9);
  assert.match(markup, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(markup, /Team avatar/);
  assert.match(markup, /rounded-\[17%\]/);
  const four = renderToStaticMarkup(createElement(GroupAvatar, { avatars: avatars.slice(0, 4) }));
  assert.match(four, /repeat\(2, minmax\(0, 1fr\)\)/);
});

test('avatar changes invalidate cached session preparation', () => {
  const account = { accountId: actor.accountId, displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: 'node_owner', passwordSet: true };
  const initial = { ...envelope, kind: 'group-message' as const, groupAvatar: { imageUrl: image, updatedAtMs: 10 } };
  const removed = { ...initial, groupAvatar: { imageUrl: null, updatedAtMs: 20 } };
  assert.notEqual(cloudGroupSessionPreparationSignature(initial, account), cloudGroupSessionPreparationSignature(removed, account));
});
