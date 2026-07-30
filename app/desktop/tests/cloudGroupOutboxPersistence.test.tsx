import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudGroupOutbox, defaultCloudGroupOutboxPersistence } from '../src/features/cloud/cloudGroupOutbox';

import { ControlledFirstSaveFailurePersistence, ControlledFirstSaveSuccessPersistence, ControlledFirstSuccessSecondFailurePersistence, MemoryStorage, ControllableIndexedDb, withBrowserPersistenceGlobals, entry } from './helpers/cloudGroupOutboxFixtures';

test('completion tombstones filter stale fallback entries before the persisted list is capped', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const completedCanonicalMessageId = entry().canonicalMessageId;
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [],
    completedCanonicalMessageIds: [completedCanonicalMessageId],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: Array.from(
      { length: 1_000 },
      (_, index) => `msg:canonical:fallback-completed:${index}`,
    ),
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const restored = await restarted.restore();
    assert.deepEqual(restored, [], 'the stale entry must stay suppressed even if its tombstone is evicted');

    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0);
    assert.deepEqual(indexedDb.value?.entries, []);
    assert.equal(indexedDb.value?.completedCanonicalMessageIds.length, 1_000);
  });
});

test('promotion retains a suppressing tombstone when fallback cleanup fails before restart', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  storage.failRemovals = true;
  const completedCanonicalMessageId = entry().canonicalMessageId;
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [],
    completedCanonicalMessageIds: [completedCanonicalMessageId],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: Array.from(
      { length: 1_000 },
      (_, index) => `msg:canonical:fallback-completed:${index}`,
    ),
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const promoted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    assert.deepEqual(await promoted.restore(), []);
    assert.equal(storage.length, 1, 'failed cleanup must leave the fallback available');
    assert.equal(
      indexedDb.value?.completedCanonicalMessageIds.includes(completedCanonicalMessageId),
      true,
      'the promoted state must retain the tombstone that suppresses the fallback entry',
    );

    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    assert.deepEqual(await restarted.restore(), []);
    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0, 'the retained fallback must not resurrect a completed delivery');
  });
});

test('enqueue rejects when neither browser persistence backend accepts the snapshot', async () => {
  await withBrowserPersistenceGlobals(undefined, undefined, async () => {
    const outbox = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    await outbox.restore();

    await assert.rejects(
      outbox.enqueue(entry()),
      /unable to persist the cloud group outbox/i,
    );
    assert.deepEqual(outbox.entries(), [], 'a rejected enqueue must not leave a memory-only entry');
    await assert.rejects(
      outbox.enqueue(entry()),
      /unable to persist the cloud group outbox/i,
      'a retry must not bypass durability through the failed in-memory entry',
    );
  });
});

test('concurrent duplicate enqueue shares the first persistence failure', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const firstEnqueue = outbox.enqueue(entry());
  const firstResult = assert.rejects(firstEnqueue, /forced first save failure/);
  await persistence.firstSaveStarted;
  const duplicateEnqueue = outbox.enqueue(entry());
  const duplicateResult = assert.rejects(duplicateEnqueue, /forced first save failure/);
  persistence.releaseFirstSave();

  await Promise.all([firstResult, duplicateResult]);
  assert.deepEqual(outbox.entries(), []);
  assert.equal(persistence.value, null);
});

test('concurrent duplicate enqueue stays pending until the shared durable save succeeds', async () => {
  const persistence = new ControlledFirstSaveSuccessPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const firstEnqueue = outbox.enqueue(entry());
  await persistence.firstSaveStarted;
  let duplicateSettled = false;
  const duplicateEnqueue = outbox.enqueue(entry()).then((result) => {
    duplicateSettled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(duplicateSettled, false, 'duplicate must not fulfill before the durable save');
  persistence.releaseFirstSave();

  const [firstResult, duplicateResult] = await Promise.all([firstEnqueue, duplicateEnqueue]);
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(persistence.saveCount, 1, 'concurrent duplicates must share one mutation transaction');

  assert.deepEqual(await outbox.enqueue(entry()), firstResult, 'an already committed duplicate remains idempotent');
  assert.equal(persistence.saveCount, 1, 'an already committed duplicate must not rewrite persistence');
});

test('delivery rejects without sending when its pending enqueue persistence fails', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const enqueueResult = assert.rejects(outbox.enqueue(entry()), /forced first save failure/);
  await persistence.firstSaveStarted;
  let sends = 0;
  const deliveryResult = assert.rejects(
    outbox.deliverDue(async () => { sends += 1; }, 0),
    /forced first save failure/,
  );
  persistence.releaseFirstSave();

  await Promise.all([enqueueResult, deliveryResult]);
  assert.equal(sends, 0, 'delivery must not escape before its outbox entry is durable');
  assert.deepEqual(outbox.entries(), []);
});

test('concurrent deliveries wait for one durable enqueue and share one delivery flight', async () => {
  const persistence = new ControlledFirstSaveSuccessPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const enqueueResult = outbox.enqueue(entry());
  await persistence.firstSaveStarted;
  const sentRecipientIds: string[] = [];
  const send = async ({ recipientId }: { recipientId: string }) => { sentRecipientIds.push(recipientId); };
  const firstDelivery = outbox.deliver('msg:canonical:one', send, { nowMs: 100, force: true });
  const secondDelivery = outbox.deliver('msg:canonical:one', send, { nowMs: 100, force: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sentRecipientIds, [], 'recipient sends must wait for the durable enqueue');
  persistence.releaseFirstSave();

  await enqueueResult;
  const [firstOutcome, secondOutcome] = await Promise.all([firstDelivery, secondDelivery]);
  assert.deepEqual(secondOutcome, firstOutcome);
  assert.deepEqual(sentRecipientIds.sort(), ['acct_a', 'acct_b']);
});

test('a queued successful enqueue cannot persist an entry whose earlier save rejected', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const rejectedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:rejected' };
  const retainedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:retained' };

  const rejectedEnqueue = outbox.enqueue(rejectedEntry);
  await persistence.firstSaveStarted;
  const retainedEnqueue = outbox.enqueue(retainedEntry);
  await Promise.resolve();
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:rejected', 'msg:canonical:retained'],
  );
  persistence.releaseFirstSave();

  await assert.rejects(rejectedEnqueue, /forced first save failure/);
  await retainedEnqueue;
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
  );

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const restored = await restarted.restore();
  assert.deepEqual(
    restored.map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
    'durable state must match the post-rollback in-memory state',
  );
});

test('a successful enqueue cannot persist a concurrent enqueue whose later save rejects', async () => {
  const persistence = new ControlledFirstSuccessSecondFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const retainedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:retained' };
  const rejectedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:rejected' };

  const retainedEnqueue = outbox.enqueue(retainedEntry);
  const rejectedEnqueue = outbox.enqueue(rejectedEntry);
  const rejectedResult = assert.rejects(rejectedEnqueue, /forced second save failure/);
  await persistence.firstSaveStarted;
  persistence.releaseFirstSave();

  await retainedEnqueue;
  await rejectedResult;
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
  );

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(
    (await restarted.restore()).map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
    'the earlier successful save must exclude the later rejected mutation',
  );
});
