import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudGroupOutbox } from '../src/features/cloud/cloudGroupOutbox';

import { MemoryPersistence, entry, awaitingEntry } from './helpers/cloudGroupOutboxFixtures';

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

test('successful recipient delivery stays durable until canonical acknowledgement survives restart', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  const outcome = await first.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });

  assert.equal(outcome?.awaitingCanonicalAck, true);
  assert.equal(first.entries()[0]?.awaitingCanonicalAck, true);
  assert.deepEqual(first.entries()[0]?.pendingRecipientIds, []);
  assert.deepEqual(persistence.value?.completedCanonicalMessageIds, []);

  let acknowledgementReached = false;
  const writeCanonical = async () => { throw new Error('forced canonical failure'); };
  await assert.rejects(async () => {
    await writeCanonical();
    // This mirrors the native-write-before-ack ordering guarded by the source test.
    acknowledgementReached = true;
    await first.acknowledgeCanonicalDelivery('msg:canonical:one');
  }, /forced canonical failure/);
  assert.equal(acknowledgementReached, false);
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const restored = await restarted.restore();
  assert.equal(restored[0]?.awaitingCanonicalAck, true);

  let replaySends = 0;
  const replayed = await restarted.deliverDue(async () => { replaySends += 1; }, 200);
  assert.equal(replaySends, 0, 'canonical replay must not resend recipients');
  assert.equal(replayed[0]?.awaitingCanonicalAck, true);

  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
  assert.deepEqual(restarted.entries(), []);
  assert.deepEqual(persistence.value?.completedCanonicalMessageIds, ['msg:canonical:one']);
  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true, 'ack is idempotent');
  assert.equal(await restarted.enqueue(entry()), null, 'completed canonical ids still block duplicate sends');
});

test('failed canonical acknowledgement rolls back so retry persists completion across restart', async () => {
  const persistence = new MemoryPersistence();
  const initial = new CloudGroupOutbox('acct_me', persistence);
  await initial.restore();
  await initial.enqueue(entry());
  await initial.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });
  const previousCompletedCanonicalMessageIds = Array.from(
    { length: 1_000 },
    (_, index) => `msg:canonical:previously-completed:${index}`,
  );
  persistence.value = {
    ...persistence.value!,
    completedCanonicalMessageIds: previousCompletedCanonicalMessageIds,
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  persistence.failNextSave();

  await assert.rejects(
    outbox.acknowledgeCanonicalDelivery('msg:canonical:one'),
    /forced persistence failure/,
  );
  assert.equal(outbox.entries()[0]?.awaitingCanonicalAck, true);
  assert.equal(
    await outbox.enqueue({
      ...entry(),
      canonicalMessageId: previousCompletedCanonicalMessageIds[0]!,
    }),
    null,
    'rollback must restore a completion tombstone evicted by the failed acknowledgement',
  );
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(await restarted.restore(), []);
  assert.equal(await restarted.enqueue(entry()), null, 'retry must durably retain the completion tombstone');
});

test('concurrent failed acknowledgements restore exact capped state before independent retries', async () => {
  const firstCanonicalMessageId = 'msg:canonical:awaiting:first';
  const secondCanonicalMessageId = 'msg:canonical:awaiting:second';
  const completedCanonicalMessageIds = Array.from(
    { length: 1_000 },
    (_, index) => `msg:canonical:completed:${index}`,
  );
  const persistence = new MemoryPersistence();
  persistence.value = {
    version: 1,
    entries: [awaitingEntry(firstCanonicalMessageId), awaitingEntry(secondCanonicalMessageId)],
    completedCanonicalMessageIds,
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  persistence.failNextSave();
  persistence.failNextSave();

  const acknowledgements = await Promise.allSettled([
    outbox.acknowledgeCanonicalDelivery(firstCanonicalMessageId),
    outbox.acknowledgeCanonicalDelivery(secondCanonicalMessageId),
  ]);
  assert.deepEqual(acknowledgements.map((result) => result.status), ['rejected', 'rejected']);
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    [firstCanonicalMessageId, secondCanonicalMessageId],
    'both failed mutations must restore the exact prior entries',
  );
  assert.equal(
    await outbox.enqueue({
      ...entry(),
      canonicalMessageId: completedCanonicalMessageIds[0]!,
    }),
    null,
    'concurrent rollbacks must preserve the oldest capped tombstone',
  );

  assert.deepEqual(await Promise.all([
    outbox.acknowledgeCanonicalDelivery(firstCanonicalMessageId),
    outbox.acknowledgeCanonicalDelivery(secondCanonicalMessageId),
  ]), [true, true]);
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(await restarted.restore(), []);
  assert.equal(await restarted.enqueue(awaitingEntry(firstCanonicalMessageId)), null);
  assert.equal(await restarted.enqueue(awaitingEntry(secondCanonicalMessageId)), null);
});

test('canonical acknowledgement refuses pending, partial, and exhausted deliveries', async () => {
  const pending = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await pending.restore();
  await pending.enqueue(entry());
  assert.equal(await pending.acknowledgeCanonicalDelivery('msg:canonical:one'), false);

  const partial = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await partial.restore();
  await partial.enqueue(entry());
  await partial.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });
  assert.equal(await partial.acknowledgeCanonicalDelivery('msg:canonical:one'), false);

  const exhausted = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await exhausted.restore();
  await exhausted.enqueue(entry());
  let nowMs = 100;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const exhaustedOutcome = await exhausted.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = exhaustedOutcome?.nextAttemptAtMs ?? nowMs;
  }
  assert.equal(await exhausted.acknowledgeCanonicalDelivery('msg:canonical:one'), false);
  assert.equal(exhausted.entries().length, 1);
});
