import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { currentCloudGroupReplyRevisions } from '../src/features/canonical/cloudGroupReplyRevisions';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { patchCanonicalCloudMessages } from '../src/features/cloud/cloudReactionProjection';
import type { IndexedCloudGroupRow } from '../src/features/cloud/cloudMessageIndex';

function reply(id: string, version: number, deliveryState: string): CanonicalSessionMessage {
  return {
    id, sessionId: 'group', senderIdentityId: 'agent:cloud:owner', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: deliveryState === 'complete' ? '8 + 5 = 13' : '',
    content: { cloudGroupMessageId: 'cloud-reply', cloudMessageVersion: version, deliveryState },
    status: deliveryState === 'complete' ? 'received' : deliveryState,
    sourceTransport: 'cloud-group-agent', sourceEventId: `cloud-group-agent:wire:${version}`,
    createdAtMs: 1, updatedAtMs: version, sequenceNum: 17,
  };
}

function state(messages: CanonicalSessionMessage[]): CanonicalSessionState {
  return {
    storagePath: '', profile: { id: 'profile', humanIdentityId: 'human:owner', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 },
    identities: [], sessions: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [], messages,
  };
}

function wire(version: number, deliveryState: string, text = '8 + 5 = 13'): IndexedCloudGroupRow {
  return {
    wire: { conversationId: 'conversation', messageId: 'wire', version },
    envelope: { groupId: 'group', message: { id: 'cloud-reply', text, deliveryState } },
  } as IndexedCloudGroupRow;
}

test('restored legacy waiting and completed rows project one answer without cloud history', () => {
  const pending = reply('legacy-raw-id', 1, 'processing');
  const complete = reply('stable-slot-id', 2, 'complete');
  for (const messages of [[pending, complete], [complete, pending]]) {
    const restored = state(messages);
    const projected = patchCanonicalCloudMessages(restored, [])!;
    assert.deepEqual(projected.messages, [complete]);
    assert.deepEqual(buildCanonicalIndexes(restored).rawMessagesBySessionId.get('group'), [complete]);
    assert.equal(restored.messages.length, 2, 'do not mutate stored history');
    assert.equal(patchCanonicalCloudMessages(projected, []), projected);
  }
});

test('deduplication precedes wire overlays so the old processing row cannot acquire final text', () => {
  const projected = patchCanonicalCloudMessages(state([
    reply('legacy-raw-id', 1, 'processing'), reply('stable-slot-id', 2, 'complete'),
  ]), [wire(2, 'complete')])!;
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0].id, 'stable-slot-id');
  assert.equal(projected.messages[0].status, 'received');
});

test('a terminal wire revision updates text and lifecycle together before persistence catches up', () => {
  for (const deliveryState of ['complete', 'failed', 'cancelled']) {
    const projected = patchCanonicalCloudMessages(state([reply('stable-slot-id', 1, 'processing')]), [
      wire(2, deliveryState),
    ])!;
    assert.equal(projected.messages[0].id, 'stable-slot-id');
    assert.equal(projected.messages[0].status, deliveryState === 'complete' ? 'received' : deliveryState);
    assert.equal((projected.messages[0].content as Record<string, unknown>).deliveryState, deliveryState);
    assert.equal(patchCanonicalCloudMessages(projected, [wire(1, 'processing', '')]), projected);
    assert.equal(patchCanonicalCloudMessages(projected, [wire(3, 'processing', '')]), projected);
  }
});

test('distinct cloud messages, groups and agents with identical answers are retained', () => {
  const first = reply('first', 2, 'complete');
  const messages = [
    first,
    { ...first, id: 'different-cloud-id', content: { ...first.content as object, cloudGroupMessageId: 'another-reply' } },
    { ...first, id: 'different-group', sessionId: 'another-group' },
    { ...first, id: 'different-agent', senderIdentityId: 'agent:cloud:peer' },
    { ...first, id: 'local-runtime', sourceTransport: 'desktop-chat' },
  ];
  assert.equal(currentCloudGroupReplyRevisions(messages), messages);
});

test('equal revisions prefer the terminal reply regardless of hydration order', () => {
  const pending = reply('pending', 2, 'processing');
  const complete = reply('complete', 2, 'complete');
  for (const rows of [[pending, complete], [complete, pending]]) {
    assert.deepEqual(currentCloudGroupReplyRevisions(rows), [complete]);
  }
});
