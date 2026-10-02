import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { messageSnapshotKey } from '../src/kordi-app/components/transcriptMessageSnapshot';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../src/kordi-app/types';

function identity(overrides: Partial<CanonicalIdentity> & Pick<CanonicalIdentity, 'id' | 'kind'>): CanonicalIdentity {
  return {
    displayName: 'Participant',
    source: 'cloud',
    avatarKey: overrides.id,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function canonicalMessage(senderIdentityId: string, overrides: Partial<CanonicalSessionMessage> = {}): CanonicalSessionMessage {
  return {
    id: `message:${senderIdentityId}`,
    sessionId: 'session:group:one',
    senderIdentityId,
    senderRole: 'person',
    messageKind: 'text',
    contentText: 'Read https://example.com/report',
    content: { schemaVersion: 1, kind: 'message' },
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

test('canonical human senders carry their account id for privacy decisions', () => {
  const human = identity({ id: 'human:acct_peer', kind: 'human', humanId: ' acct_peer ' });
  const mapped = mapCanonicalMessage(
    canonicalMessage(human.id),
    new Map([[human.id, human]]),
    'human:acct_self',
  );
  assert.equal(mapped?.senderHumanId, 'acct_peer');
  assert.equal(mapped?.senderType, 'human');
});

test('agent and unknown senders have no human id', () => {
  const owner = identity({ id: 'human:acct_owner', kind: 'human', humanId: 'acct_owner' });
  const agent = identity({ id: 'agent:acct_owner:helper', kind: 'agent', ownerIdentityId: owner.id, agentId: 'helper' });
  const identities = new Map([[owner.id, owner], [agent.id, agent]]);
  const agentMessage = mapCanonicalMessage(
    canonicalMessage(agent.id, { senderRole: 'external-agent', messageKind: 'agent-turn', status: 'complete' }),
    identities,
    'human:acct_self',
  );
  assert.equal(agentMessage?.senderHumanId, null);

  const blankHuman = identity({ id: 'human:local:abcd', kind: 'human', humanId: '  ' });
  const unknown = mapCanonicalMessage(canonicalMessage(blankHuman.id), new Map([[blankHuman.id, blankHuman]]), null);
  assert.equal(unknown?.senderHumanId, null);
  assert.equal(mapCanonicalMessage(canonicalMessage('human:missing'), new Map(), null)?.senderHumanId, null);
});

test('transcript rows re-render when the sender human id arrives later', () => {
  const base: Message = { role: 'person', text: 'https://example.com/report', time: '09:00', senderIdentityId: 'human:acct_peer' };
  assert.notEqual(
    messageSnapshotKey(base),
    messageSnapshotKey({ ...base, senderHumanId: 'acct_peer' }),
  );
  assert.equal(
    messageSnapshotKey({ ...base, senderHumanId: 'acct_peer' }),
    messageSnapshotKey({ ...base, senderHumanId: 'acct_peer' }),
  );
});
