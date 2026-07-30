import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudGroupOutbox, cloudGroupOutboxDeliveryStatus, patchCanonicalCloudGroupOutboxDelivery } from '../src/features/cloud/cloudGroupOutbox';

import { MemoryPersistence, entry, canonicalState } from './helpers/cloudGroupOutboxFixtures';

test('legacy persisted entries normalize without an awaiting canonical acknowledgement phase', async () => {
  const persistence = new MemoryPersistence();
  persistence.value = {
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: [],
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);

  const restored = await outbox.restore();

  assert.equal(restored[0]?.awaitingCanonicalAck, false);
});

test('restart retains the exact canonical target when it is older than 200 newer rows', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  await first.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  const newerCanonicalMessageIds = Array.from(
    { length: 201 },
    (_, index) => `msg:canonical:newer:${index + 1}`,
  );
  const latestPageIds = newerCanonicalMessageIds.slice(-200);
  assert.equal(latestPageIds.includes('msg:canonical:one'), false);

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  const [outcome] = await restarted.deliverDue(async () => {}, 1_100);
  assert.equal(outcome?.canonicalMessageId, 'msg:canonical:one');
  assert.deepEqual(cloudGroupOutboxDeliveryStatus(outcome!), {
    status: 'delivered',
    deliveryState: 'delivered',
    deliveredRecipientIds: ['acct_a', 'acct_b'],
    pendingRecipientIds: [],
    exhaustedRecipientIds: [],
  });
  assert.equal(outcome?.awaitingCanonicalAck, true);
  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
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
  assert.equal(outbox.entries()[0]?.awaitingCanonicalAck, true);
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
  assert.deepEqual(outbox.entries(), []);
});

test('a second enqueue with a completed canonical id cannot duplicate delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let sends = 0;
  await outbox.deliver('msg:canonical:one', async () => { sends += 1; }, { nowMs: 100, force: true });
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);

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

test('manual retry durably requeues exhausted recipients with the refreshed payload', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let nowMs = 100;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const outcome = await outbox.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = outcome?.nextAttemptAtMs ?? nowMs;
  }

  const requeued = await outbox.requeueFailed({
    ...entry(),
    envelope: 'refreshed-envelope',
    attachments: [{
      attachmentId: 'att_retry',
      name: 'retry.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
    }],
  });

  assert.equal(requeued?.envelope, 'refreshed-envelope');
  assert.deepEqual(requeued?.pendingRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual(requeued?.deliveredRecipientIds, []);
  assert.deepEqual(requeued?.exhaustedRecipientIds, undefined);
  assert.deepEqual(requeued?.attemptsByRecipientId, { acct_a: 0, acct_b: 0 });
  assert.equal(requeued?.payloadVersion, 1);
  assert.equal(requeued?.deliveryGeneration, 1);
  assert.equal(persistence.value?.entries[0]?.envelope, 'refreshed-envelope');

  const retried: string[] = [];
  await outbox.deliver('msg:canonical:one', async ({ recipientId, entry: retriedEntry }) => {
    retried.push(recipientId);
    assert.equal(retriedEntry.attachments?.[0]?.attachmentId, 'att_retry');
  }, { nowMs: nowMs + 1, force: true });
  assert.deepEqual(retried.sort(), ['acct_a', 'acct_b']);
});

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
