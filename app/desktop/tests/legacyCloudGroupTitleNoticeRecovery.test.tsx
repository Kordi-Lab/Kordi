import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLegacyCloudGroupTitleNoticeClassificationDelta } from '../src/features/cloud/useLegacyCloudGroupTitleNoticeRecovery';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

function groupTitleNotice(id: string, synchronizationOnly = false): CanonicalSessionMessage {
  return {
    id,
    sessionId: 'session:group:one',
    senderIdentityId: 'human:relay',
    senderRole: 'system',
    messageKind: 'status',
    contentText: 'Relay changed the group name to Research',
    content: {
      kind: 'group-title-update',
      scope: 'group',
      title: 'Research',
      ...(synchronizationOnly ? {
        sourceControlKind: 'group-invite',
        synchronizationOnly: true,
      } : {}),
    },
    status: 'complete',
    sequenceNum: 3,
    createdAtMs: 3,
    updatedAtMs: 3,
    sourceTransport: 'cloud-group-title-update',
    sourceEventId: `cloud-group-title-update:${id.split(':').at(-1)}`,
  };
}

function canonicalState(messages: CanonicalSessionMessage[]): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:test',
      displayName: 'Me',
      humanIdentityId: 'human:test',
      activeAgentIdentityId: 'agent:test',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [{
      id: 'session:group:one',
      kind: 'group',
      title: 'Research',
      status: 'active',
      createdByIdentityId: 'human:test',
      createdAtMs: 1,
      updatedAtMs: 3,
      lastMessageAtMs: 3,
    }],
    participants: [],
    messages,
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('legacy title classification patches only loaded rows and restores session activity', () => {
  const loadedId = 'cloud-group-title-notice:loaded';
  const unloadedId = 'cloud-group-title-notice:unloaded';
  const state = canonicalState([groupTitleNotice(loadedId)]);
  const next = applyLegacyCloudGroupTitleNoticeClassificationDelta(state, {
    messages: [
      groupTitleNotice(loadedId, true),
      groupTitleNotice(unloadedId, true),
    ],
    sessionRepairs: [{
      sessionId: 'session:group:one',
      lastMessageAtMs: 2,
      replacedThroughAtMs: 3,
    }],
  });

  assert.notEqual(next, state);
  assert.equal(next?.messages.length, 1, 'cold historical rows must stay out of the loaded store');
  assert.equal(next?.messages[0]?.content?.synchronizationOnly, true);
  assert.equal(next?.sessions[0]?.lastMessageAtMs, 2);
});

test('legacy title repair cannot roll newer concurrent session activity backward', () => {
  const state = canonicalState([]);
  state.sessions[0].lastMessageAtMs = 4;
  const next = applyLegacyCloudGroupTitleNoticeClassificationDelta(state, {
    messages: [],
    sessionRepairs: [{
      sessionId: 'session:group:one',
      lastMessageAtMs: 2,
      replacedThroughAtMs: 3,
    }],
  });

  assert.equal(next, state);
  assert.equal(next?.sessions[0]?.lastMessageAtMs, 4);
});

test('empty legacy title classification preserves canonical state identity', () => {
  const state = canonicalState([]);
  assert.equal(applyLegacyCloudGroupTitleNoticeClassificationDelta(state, {
    messages: [],
    sessionRepairs: [],
  }), state);
});
