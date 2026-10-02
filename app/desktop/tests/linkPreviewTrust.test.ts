import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CloudContactSummary } from '../src/features/cloud/authClient';
import {
  applyCloudContactsRefreshSnapshot,
  cloudContactAddedActorAccountId,
  mergeCloudContactSummarySnapshot,
} from '../src/features/cloud/useCloudContacts';
import { nextServerContactRows } from '../src/features/cloud/cloudContactsSnapshot';
import { trustedLinkPreviewHumanIds } from '../src/features/privacy/linkPreviewPolicy';

const SELF = 'acct_self';

function serverRows(previous: readonly CloudContactSummary[], refreshed: readonly CloudContactSummary[]) {
  return nextServerContactRows(previous, refreshed, SELF, SELF);
}

function row(accountId: string, overrides: Partial<CloudContactSummary> = {}): CloudContactSummary {
  return {
    accountId,
    displayName: accountId,
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

test('server contact rows are replaced on refresh, keep identity when unchanged, and drop removed rows', () => {
  const first = serverRows([], [row('acct_a'), row('acct_b')]);
  assert.deepEqual(first.map((item) => item.accountId), ['acct_a', 'acct_b']);

  const same = serverRows(first, structuredClone([...first]));
  assert.equal(same, first, 'an equal response keeps the previous array so trust does not recompute');

  const dropped = serverRows(first, [row('acct_b')]);
  assert.deepEqual(dropped.map((item) => item.accountId), ['acct_b']);
  assert.notEqual(dropped, first);
});

test('a contact hint from another account never grants link preview trust', () => {
  const self = SELF;
  const responseRows = [row('acct_friend')];
  let display = { contacts: [row('acct_friend')], requests: [] };
  let serverContacts = serverRows([], responseRows);

  // Any account can send a contact.added event naming the viewer as the peer.
  const hintedId = cloudContactAddedActorAccountId(
    { actor_account_id: 'acct_stranger', peer_account_id: self },
    self,
  );
  assert.equal(hintedId, 'acct_stranger');
  display = mergeCloudContactSummarySnapshot(display, row('acct_stranger'));

  // The refresh that follows the hint returns only the viewer's own rows.
  display = applyCloudContactsRefreshSnapshot(display, { contacts: responseRows, requests: [] }, {
    startedMutationRevision: 2,
    currentMutationRevision: 2,
  });
  serverContacts = serverRows(serverContacts, responseRows);

  assert.ok(
    display.contacts.some((contact) => contact.accountId === 'acct_stranger'),
    'the merged display list still holds the hinted row',
  );
  const trusted = trustedLinkPreviewHumanIds({ selfAccountId: self, serverContacts });
  assert.deepEqual([...trusted].sort(), ['acct_friend', 'acct_self']);
});

test('a contact the server stops returning loses link preview trust on the next refresh', () => {
  const before = serverRows([], [row('acct_friend'), row('acct_other')]);
  assert.ok(trustedLinkPreviewHumanIds({ selfAccountId: 'acct_self', serverContacts: before }).has('acct_friend'));

  const after = serverRows(before, [row('acct_other')]);
  const trusted = trustedLinkPreviewHumanIds({ selfAccountId: 'acct_self', serverContacts: after });
  assert.equal(trusted.has('acct_friend'), false);
  assert.equal(trusted.has('acct_other'), true);
});

test('a contacts response fetched with another account session never replaces the rows', () => {
  const own = serverRows([], [row('acct_friend')]);
  const otherAccountRows = [row('acct_other_contact')];

  const switched = nextServerContactRows(own, otherAccountRows, SELF, 'acct_second');
  assert.equal(switched, own);
  assert.equal(
    trustedLinkPreviewHumanIds({ selfAccountId: SELF, serverContacts: switched }).has('acct_other_contact'),
    false,
  );
  assert.equal(nextServerContactRows([], otherAccountRows, SELF, null).length, 0, 'a missing session grants nothing');
  assert.equal(nextServerContactRows([], otherAccountRows, ' ', ' ').length, 0, 'an empty store account grants nothing');
  assert.deepEqual(
    nextServerContactRows(own, otherAccountRows, SELF, ` ${SELF} `).map((item) => item.accountId),
    ['acct_other_contact'],
    'the same account replaces the rows',
  );
});

test('the trust hook reads only the server contact rows of the contacts store', () => {
  const source = readFileSync(new URL('../src/features/privacy/useLinkPreviewTrust.ts', import.meta.url), 'utf8');
  assert.match(source, /const \{ serverContacts \} = useCloudContacts\(/);
  assert.doesNotMatch(source, /\{\s*contacts\s*\}/);
  const store = readFileSync(new URL('../src/features/cloud/useCloudContacts.ts', import.meta.url), 'utf8');
  const assignments = store.match(/serverContacts = nextServerContactRows\(/g) ?? [];
  assert.equal(assignments.length, 1, 'only the contacts response refresh writes server rows');
});
