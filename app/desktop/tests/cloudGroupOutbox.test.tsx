import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudGroupOutbox,
  patchCanonicalCloudGroupOutboxDelivery,
  type CloudGroupOutboxPersistedState,
  type CloudGroupOutboxPersistence,
} from '../src/features/cloud/cloudGroupOutbox';
import type { CanonicalSessionState } from '../src/kordi-app/types';

class MemoryPersistence implements CloudGroupOutboxPersistence {
  value: CloudGroupOutboxPersistedState | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: CloudGroupOutboxPersistedState) { this.value = structuredClone(value); }
}

function entry() {
  return {
    canonicalMessageId: 'msg:canonical:one',
    sessionId: 'session:group:one',
    envelope: 'encoded-envelope',
    pendingRecipientIds: ['acct_a', 'acct_b'],
    deliveredRecipientIds: [],
    attemptsByRecipientId: {},
    nextAttemptAtMs: 0,
  };
}

test('one fulfilled and one rejected target leaves only the failed recipient pending', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  const sentClientIds: string[] = [];

  const outcome = await outbox.deliver('msg:canonical:one', async ({ recipientId, clientMessageId }) => {
    sentClientIds.push(clientMessageId);
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  assert.deepEqual(sentClientIds.sort(), [
    'msg:canonical:one:acct_a',
    'msg:canonical:one:acct_b',
  ]);
  assert.deepEqual(outcome?.deliveredRecipientIds, ['acct_a']);
  assert.deepEqual(outcome?.pendingRecipientIds, ['acct_b']);
  assert.equal(outcome?.nextAttemptAtMs, 1_100);
});

test('restart restores a pending outbox entry', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  await first.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  assert.deepEqual(restarted.entries()[0]?.pendingRecipientIds, ['acct_b']);
  assert.deepEqual(restarted.entries()[0]?.deliveredRecipientIds, ['acct_a']);
});

test('retry sends only the failed recipient', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  await outbox.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });
  const retried: string[] = [];

  await outbox.deliverDue(async ({ recipientId }) => {
    retried.push(recipientId);
  }, 1_100);

  assert.deepEqual(retried, ['acct_b']);
  assert.deepEqual(outbox.entries(), []);
});

test('a second enqueue with a completed canonical id cannot duplicate delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let sends = 0;
  await outbox.deliver('msg:canonical:one', async () => { sends += 1; }, { nowMs: 100, force: true });

  const duplicate = await outbox.enqueue(entry());
  await outbox.deliver('msg:canonical:one', async () => { sends += 1; }, { nowMs: 200, force: true });

  assert.equal(duplicate, null);
  assert.equal(sends, 2);
});

test('six rejected attempts become a durable exhausted failure instead of retrying forever', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let nowMs = 100;
  let outcome = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    outcome = await outbox.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = outcome?.nextAttemptAtMs ?? nowMs;
  }

  assert.deepEqual(outcome?.pendingRecipientIds, []);
  assert.deepEqual(outcome?.exhaustedRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual(outbox.entries()[0]?.exhaustedRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual((await outbox.deliverDue(async () => { throw new Error('must not retry'); }, nowMs + 30_000)), []);
});

function canonicalState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical',
    profile: {
      id: 'profile',
      humanIdentityId: 'human:me',
      storageRoot: '/tmp/canonical',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'msg:canonical:one',
      sessionId: 'session:group:one',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: { deliveryState: 'sending' },
      status: 'sending',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('canonical delivery state reports partial and exhausted recipients honestly', () => {
  const state = patchCanonicalCloudGroupOutboxDelivery(canonicalState(), {
    ...entry(),
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a'],
    exhaustedRecipientIds: ['acct_b'],
    attemptsByRecipientId: { acct_b: 6 },
  });
  const message = state?.messages[0];
  const content = message?.content as Record<string, unknown>;

  assert.equal(message?.status, 'delivered');
  assert.equal(content.deliveryState, 'partial');
  assert.deepEqual(content.deliveredRecipientIds, ['acct_a']);
  assert.deepEqual(content.pendingRecipientIds, []);
  assert.deepEqual(content.exhaustedRecipientIds, ['acct_b']);
});

test('canonical delivery state is failed only when every recipient is exhausted', () => {
  const state = patchCanonicalCloudGroupOutboxDelivery(canonicalState(), {
    ...entry(),
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct_a', 'acct_b'],
    attemptsByRecipientId: { acct_a: 6, acct_b: 6 },
  });
  assert.equal(state?.messages[0]?.status, 'failed');
  assert.equal((state?.messages[0]?.content as Record<string, unknown>).deliveryState, 'failed');
});
