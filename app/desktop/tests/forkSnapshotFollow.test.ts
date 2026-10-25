import assert from 'node:assert/strict';
import { test } from 'node:test';

import { followRunningForkSnapshots } from '../src/features/canonical/forkSnapshotFollow';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const row = (overrides: Partial<CanonicalSessionMessage>): CanonicalSessionMessage => ({
  id: 'row', sessionId: 'session', senderIdentityId: 'agent:self', senderRole: 'owned-agent', messageKind: 'agent-turn',
  contentText: '', content: { deliveryState: 'processing' }, status: 'processing', parentMessageId: null,
  sequenceNum: 2, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: null,
  ...overrides,
});
const parentReply = row({ id: 'msg:cloud:self:response:01a1', sessionId: '4df655a8', status: 'complete',
  contentText: 'Hey! What can I help with?', content: { deliveryState: 'complete' }, updatedAtMs: 7_000 });
const forkCopy = row({ id: 'msg:copy', sessionId: 'session:fork:10b5', sourceTransport: 'canonical-fork-snapshot',
  sourceEventId: 'fork-snapshot:session:fork:10b5:4df655a8:msg:cloud:self:response:01a1' });
const state = (messages: CanonicalSessionMessage[]) => ({ sessions: [], participants: [], identities: [], messages }) as unknown as CanonicalSessionState;

test('a fork copy of a running reply shows its source once it finishes', () => {
  const next = followRunningForkSnapshots(state([parentReply, forkCopy]))!;
  const copy = next.messages.find((message) => message.id === 'msg:copy')!;
  assert.equal(copy.status, 'complete');
  assert.equal(copy.contentText, 'Hey! What can I help with?');
  assert.equal(copy.sessionId, 'session:fork:10b5');
  assert.equal(copy.updatedAtMs, 7_000);
});

test('finished copies, unknown sources, and plain rows stay as they are', () => {
  const finished = { ...forkCopy, status: 'complete', contentText: 'Kept answer' };
  const unchanged = state([parentReply, finished, row({ id: 'plain' })]);
  assert.equal(followRunningForkSnapshots(unchanged), unchanged);
  const orphan = state([forkCopy]);
  assert.equal(followRunningForkSnapshots(orphan), orphan);
  assert.equal(followRunningForkSnapshots(null), null);
});
