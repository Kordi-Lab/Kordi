import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';

import type { CloudGroupInvitationPreview } from '../src/features/cloud/cloudIdentityTypes';
import { GroupInvitationDialog } from '../src/pages/GroupInvitationDialog';
import { groupInviterAvatarSeed } from '../src/pages/groupInvitationAvatarSeed';
import { mountInDom, stubCloudNetwork } from './helpers/safetyDom';

const RESOLVE_PATH = '/v1/cloud/invitations/groups/resolve/kordi_gi_preview';
const group = { name: 'Product Team', memberCount: 3 };
const expiresAt = '2099-01-01T00:00:00Z';

async function renderPreview(body: Record<string, unknown>) {
  const network = stubCloudNetwork(({ path }) => (
    path === RESOLVE_PATH ? Response.json(body) : new Response('', { status: 404 })
  ));
  const dom = await mountInDom();
  try {
    await dom.render(createElement(GroupInvitationDialog, {
      invitationToken: 'kordi_gi_preview',
      onDismiss: () => undefined,
      onJoined: () => undefined,
    }));
  } catch (error) {
    await dom.cleanup();
    network.restore();
    throw error;
  }
  return {
    dom,
    network,
    async cleanup() {
      await dom.cleanup();
      network.restore();
    },
  };
}

test('the inviter avatar seed no longer depends on a Kordi ID', () => {
  assert.equal(groupInviterAvatarSeed({ displayName: 'Ada Lovelace', avatarUrl: null }), 'group-inviter:Ada Lovelace');
  assert.equal(groupInviterAvatarSeed({ displayName: null, avatarUrl: null }), 'group-inviter:unknown');
  assert.equal(groupInviterAvatarSeed({ displayName: '  ', avatarUrl: null }), 'group-inviter:unknown');
  assert.equal(
    groupInviterAvatarSeed({ displayName: 'Ada Lovelace', kordiId: '123456789', avatarUrl: null }),
    'group-inviter:123456789',
    'previews from older servers keep their existing seed',
  );
});

test('a preview without a Kordi ID or avatar renders the inviter by name with a placeholder avatar', async () => {
  const preview: CloudGroupInvitationPreview = {
    inviter: { displayName: 'Ada Lovelace', avatarUrl: null },
    group,
    expiresAt,
  };
  const view = await renderPreview(preview);
  try {
    assert.match(view.dom.text(), /Product Team/);
    assert.match(view.dom.text(), /3 members/);
    assert.match(view.dom.text(), /Ada Lovelace invited you to join\./);
    assert.ok(view.dom.findButton('Join group'), 'the invitation can still be accepted');
    const avatar = view.dom.document.querySelector('[aria-label="Ada Lovelace avatar"]');
    assert.ok(avatar, 'the inviter avatar renders');
    assert.equal(avatar?.getAttribute('data-avatar-state'), 'fallback');
    assert.doesNotMatch(view.dom.host.innerHTML, /undefined/);
  } finally {
    await view.cleanup();
  }
});

test('a preview without an inviter name falls back to a generic inviter', async () => {
  const view = await renderPreview({ inviter: { displayName: null, avatarUrl: null }, group, expiresAt });
  try {
    assert.match(view.dom.text(), /A Kordi user invited you to join\./);
    assert.ok(view.dom.findButton('Join group'));
    assert.doesNotMatch(view.dom.host.innerHTML, /undefined/);
  } finally {
    await view.cleanup();
  }
});
