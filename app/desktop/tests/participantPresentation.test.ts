import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayCanonicalParticipants } from '../src/features/canonical/readModel/participantPresentation';
import type { ConversationParticipant } from '../src/kordi-app/types';

const human = (id: string, name: string): ConversationParticipant => ({ id, name, kind: 'human', role: 'person' });
const agent = (id: string, ownerIdentityId: string, extra: Partial<ConversationParticipant> = {}): ConversationParticipant => ({
  id,
  name: 'Kordi',
  kind: 'agent',
  role: 'delegate',
  ownerIdentityId,
  ...extra,
});

test('one owner agent with cloud and local identities collapses to the cloud row', () => {
  const result = displayCanonicalParticipants([
    agent('agent:local:abc', 'human:acct_x', { presenceStatus: 'online', presenceDetail: 'Mac' }),
    agent('agent:cloud-self:acct_x', 'human:acct_x', { name: "Memory Tester A's Kordi", presenceStatus: 'offline' }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'agent:cloud-self:acct_x');
  assert.equal(result[0].presenceStatus, 'online');
  assert.equal(result[0].presenceDetail, 'Mac');
});

test('agents of different owners stay separate', () => {
  const result = displayCanonicalParticipants([
    agent('agent:cloud-self:acct_x', 'human:acct_x'),
    agent('agent:cloud-self:acct_y', 'human:acct_y'),
  ]);

  assert.deepEqual(result.map((participant) => participant.id), ['agent:cloud-self:acct_x', 'agent:cloud-self:acct_y']);
});

test('a human and their agent stay separate', () => {
  const result = displayCanonicalParticipants([
    human('human:acct_x', 'Kordi'),
    agent('agent:local:abc', 'human:acct_x'),
  ]);

  assert.equal(result.length, 2);
});
