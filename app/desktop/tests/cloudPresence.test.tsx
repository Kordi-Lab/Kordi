import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  applyPresenceSnapshot,
  cloudPresenceChangedFromWsPayload,
  mergePresenceEvent,
  presenceStatusForAccount,
  shouldRefreshPresenceForWsSubject,
} from '../src/features/cloud/presence';
import { IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';

test('presence snapshot stores account statuses by account id', () => {
  const snapshot = applyPresenceSnapshot({}, {
    accounts: [
      { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' },
      { accountId: 'acct_2', status: 'offline', updatedAt: '2026-05-23T00:01:00Z' },
    ],
  });
  assert.equal(presenceStatusForAccount(snapshot, 'acct_1'), 'online');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_2'), 'offline');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_missing'), 'offline');
});

test('presence websocket event updates a single account', () => {
  const next = mergePresenceEvent({}, { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' });
  assert.equal(next.acct_1?.status, 'online');
});

test('presence subject and payload parser recognize account changes', () => {
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.presence.account.acct_1'), true);
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.message.arrived.acct_1'), false);
  assert.deepEqual(cloudPresenceChangedFromWsPayload({ account_id: 'acct_1', status: 'online', occurred_at: 'now' }), {
    accountId: 'acct_1',
    status: 'online',
    updatedAt: 'now',
  });
});

test('IdentityAvatar can render an online presence light without visible status text', () => {
  const html = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_1',
    name: '111',
    presenceStatus: 'online',
  }));
  assert.match(html, /app-presence-light/);
  assert.match(html, /data-presence-status="online"/);
  assert.doesNotMatch(html, />Online</);
});

test('IdentityAvatar can render an offline presence light without visible status text', () => {
  const html = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_2',
    name: '222',
    presenceStatus: 'offline',
  }));
  assert.match(html, /app-presence-light/);
  assert.match(html, /data-presence-status="offline"/);
  assert.doesNotMatch(html, />Offline</);
});
