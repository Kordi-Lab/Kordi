import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCanonicalProfileIdentityDelta } from '../src/features/canonical/canonicalStateReducers';
import type { CanonicalSessionState } from '../src/kordi-app/types';

function profileState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:legacy',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('equivalent profile identity delta replay preserves the complete state reference', () => {
  const state = profileState();
  const once = applyCanonicalProfileIdentityDelta(state, {
    profile: { ...state.profile, humanIdentityId: 'human:acct', updatedAtMs: 2 },
    identity: {
      id: 'human:acct',
      kind: 'human',
      displayName: 'Cloud Name',
      ownerIdentityId: null,
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: 'acct',
      agentId: null,
      avatarKey: 'acct',
      profileImageUrl: null,
      metadata: { accountId: 'acct', cloudProfileIdentity: true },
      createdAtMs: 2,
      updatedAtMs: 2,
    },
    previousIdentityId: 'human:legacy',
    groupSelfSessionIds: [],
  });
  assert.ok(once);
  const stableIdentity = once.identities.find((identity) => identity.id === 'human:acct');
  assert.ok(stableIdentity);

  const replayed = applyCanonicalProfileIdentityDelta(once, {
    profile: { ...once.profile },
    identity: { ...stableIdentity, metadata: { ...(stableIdentity.metadata as Record<string, unknown>) } },
    previousIdentityId: 'human:legacy',
    groupSelfSessionIds: [],
  });

  assert.equal(replayed, once);
  assert.equal(replayed?.profile, once.profile);
  assert.equal(replayed?.identities, once.identities);
  assert.equal(replayed?.messages, once.messages);
});
