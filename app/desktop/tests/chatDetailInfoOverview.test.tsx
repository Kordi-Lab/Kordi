import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderInfoPanel } from './helpers/chatDetailPanelFixtures';

test('chat detail info shows one row for an owner agent with cloud and local identities', () => {
  const markup = renderInfoPanel({
    participants: ['Me', 'Kordi', 'Kordi'],
    canonicalMessageCount: 4,
    canonicalDelegatedExchangeCount: 2,
    canonicalContextSnapshotCount: 3,
    canonicalParticipants: [
      { id: 'human:acct_x', name: 'Me', kind: 'human', role: 'self', presenceStatus: 'online' },
      {
        id: 'agent:cloud-self:acct_x',
        name: 'Kordi',
        kind: 'agent',
        role: 'delegate',
        ownerIdentityId: 'human:acct_x',
        ownerName: 'Me',
        presenceStatus: 'offline',
      },
      {
        id: 'agent:local:abc',
        name: 'Kordi',
        kind: 'agent',
        role: 'delegate',
        ownerIdentityId: 'human:acct_x',
        ownerName: 'Me',
        presenceStatus: 'online',
      },
    ],
  });

  assert.equal(markup.match(/Owner: /g)?.length, 1);
  assert.match(markup, /data-chat-info-summary="">2 participants · 4 messages · Active /);
  assert.equal(markup.match(/data-presence-status="online"/g)?.length, 2);
  assert.doesNotMatch(markup, /Canonical graph|Context cache|delegation|snapshot/);
});

test('chat detail info shows syncing history while the projection is pending', () => {
  const markup = renderInfoPanel({ canonicalProjectionPending: true, canonicalMessageCount: 1 });

  assert.match(markup, /data-chat-info-summary="">3 participants · Syncing history… · Active /);
});
