import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudGroupOutbox, CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS, cloudGroupOutboxNextWakeAtMs, defaultCloudGroupOutboxPersistence } from '../src/features/cloud/cloudGroupOutbox';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudGroupOutboxAttachmentSources, prepareCloudGroupOutboxEntryAttachments } from '../src/features/cloud/cloudGroupOutboxAttachments';

import { MemoryPersistence, MemoryStorage, ControllableIndexedDb, withBrowserPersistenceGlobals, entry, awaitingEntry } from './helpers/cloudGroupOutboxFixtures';

test('outbox schedules canonical acknowledgement replay without resending recipients', () => {
  const nowMs = 500;
  assert.equal(
    cloudGroupOutboxNextWakeAtMs([awaitingEntry('msg:canonical:awaiting')], nowMs),
    nowMs + CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS,
  );
  assert.equal(cloudGroupOutboxNextWakeAtMs([{ ...entry(), nextAttemptAtMs: 1_100 }], nowMs), 1_100);
  assert.equal(cloudGroupOutboxNextWakeAtMs([{
    ...entry(),
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct_a', 'acct_b'],
  }], nowMs), null);
});

test('outbox keeps image previews in attachment metadata for recipient delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const previewUrl = 'data:image/webp;base64,preview';

  await outbox.enqueue({
    ...entry(),
    attachments: [{
      attachmentId: 'att_preview',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
      previewUrl,
    }],
  });

  assert.equal(outbox.entries()[0]?.attachments?.[0]?.previewUrl, previewUrl);
  assert.equal(persistence.value?.entries[0]?.attachments?.[0]?.previewUrl, previewUrl);
});

test('pending group videos retain their poster until upload preparation', async () => {
  const previewUrl = 'data:image/jpeg;base64,cG9zdGVy';
  const [source] = cloudGroupOutboxAttachmentSources([{
    id: 'local_video',
    path: '/tmp/kordi/video.mp4',
    localPath: '/tmp/kordi/video.mp4',
    name: 'video.mp4',
    kind: 'file',
    mimeType: 'video/mp4',
    previewUrl,
  }]);
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue({ ...entry(), pendingAttachments: [source!] });

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const [restored] = await restarted.restore();
  assert.equal(restored?.pendingAttachments?.[0]?.previewUrl, previewUrl);
});

test('outbox durably retains local attachment sources until upload completes', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue({
    ...entry(),
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
    }],
  });

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const [restored] = await restarted.restore();
  assert.deepEqual(restored?.pendingAttachments, [{
    id: 'local_image',
    path: '/tmp/kordi/image.png',
    name: 'image.png',
    kind: 'image',
    formatLabel: null,
    mimeType: 'image/png',
    sizeBytes: 42,
  }]);
  assert.equal(restored?.attachments, undefined);

  await restarted.completeAttachmentUpload('msg:canonical:one', {
    envelope: 'encoded-envelope-with-attachment-reference',
    attachments: [{
      attachmentId: 'att_uploaded',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
      previewUrl: 'data:image/webp;base64,preview',
    }],
  });

  const completed = new CloudGroupOutbox('acct_me', persistence);
  const [uploaded] = await completed.restore();
  assert.equal(uploaded?.envelope, 'encoded-envelope-with-attachment-reference');
  assert.equal(uploaded?.pendingAttachments, undefined);
  assert.equal(uploaded?.attachments?.[0]?.attachmentId, 'att_uploaded');
});

test('failed attachment payload persistence leaves the pre-upload outbox recoverable', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue({
    ...entry(),
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });
  persistence.failNextSave();

  await assert.rejects(
    outbox.completeAttachmentUpload('msg:canonical:one', {
      envelope: 'encoded-envelope-with-attachment-reference',
      attachments: [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }],
    }),
    /forced persistence failure/,
  );

  assert.equal(outbox.entries()[0]?.envelope, 'encoded-envelope');
  assert.equal(outbox.entries()[0]?.attachments, undefined);
  assert.equal(outbox.entries()[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.equal((await restarted.restore())[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');
});

test('attachment preparation retries upload from the durable source before recipient delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const envelope = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg:canonical:one',
      senderAccountId: 'acct_me',
      text: 'image',
      createdAtMs: 100,
    },
  });
  const queued = await outbox.enqueue({
    ...entry(),
    envelope,
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });
  assert.ok(queued);

  await assert.rejects(
    prepareCloudGroupOutboxEntryAttachments({
      outbox,
      entry: queued,
      upload: async () => { throw new Error('offline during upload'); },
    }),
    /offline during upload/,
  );
  assert.equal(outbox.entries()[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');

  const prepared = await prepareCloudGroupOutboxEntryAttachments({
    outbox,
    entry: outbox.entries()[0]!,
    upload: async (sources) => {
      assert.equal(sources[0]?.path, '/tmp/kordi/image.png');
      return [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }];
    },
  });

  assert.equal(prepared.pendingAttachments, undefined);
  assert.equal(prepared.attachments?.[0]?.attachmentId, 'att_uploaded');
  assert.equal(parseCloudGroupControl(prepared.envelope)?.message?.attachments?.[0]?.attachmentId, 'att_uploaded');
  assert.equal(persistence.value?.entries[0]?.pendingAttachments, undefined);
});

test('upload failure sends no recipient payload and restart resumes the complete image delivery', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  const envelope = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg:canonical:one',
      senderAccountId: 'acct_me',
      text: '',
      createdAtMs: 100,
    },
  });
  await first.enqueue({
    ...entry(),
    envelope,
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });

  let firstPreparation: Promise<ReturnType<CloudGroupOutbox['entries']>[number]> | null = null;
  let uploadAttempts = 0;
  let recipientSends = 0;
  const failedOutcome = await first.deliver('msg:canonical:one', async ({ entry: deliveryEntry }) => {
    firstPreparation ??= prepareCloudGroupOutboxEntryAttachments({
      outbox: first,
      entry: deliveryEntry,
      upload: async () => {
        uploadAttempts += 1;
        throw new Error('offline during upload');
      },
    });
    await firstPreparation;
    recipientSends += 1;
  }, { nowMs: 100, force: true });

  assert.equal(uploadAttempts, 1, 'all recipients must share one attachment upload attempt');
  assert.equal(recipientSends, 0, 'no recipient transport may run without an uploaded attachment payload');
  assert.deepEqual(failedOutcome?.pendingRecipientIds, ['acct_a', 'acct_b']);
  assert.equal(failedOutcome?.attemptsByRecipientId.acct_a, 1);
  assert.equal(failedOutcome?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  let resumedPreparation: Promise<ReturnType<CloudGroupOutbox['entries']>[number]> | null = null;
  const deliveredRecipientIds: string[] = [];
  await restarted.deliverDue(async ({ recipientId, entry: deliveryEntry }) => {
    resumedPreparation ??= prepareCloudGroupOutboxEntryAttachments({
      outbox: restarted,
      entry: deliveryEntry,
      upload: async () => [{
        attachmentId: 'att_uploaded_after_restart',
        name: 'image.png',
        kind: 'image',
        previewUrl: 'data:image/webp;base64,preview',
      }],
    });
    const ready = await resumedPreparation;
    assert.equal(ready.attachments?.[0]?.attachmentId, 'att_uploaded_after_restart');
    assert.equal(parseCloudGroupControl(ready.envelope)?.message?.attachments?.[0]?.attachmentId, 'att_uploaded_after_restart');
    deliveredRecipientIds.push(recipientId);
  }, 1_100);

  assert.deepEqual(deliveredRecipientIds.sort(), ['acct_a', 'acct_b']);
  assert.equal(restarted.entries()[0]?.awaitingCanonicalAck, true);
});

test('restart prefers a completed uploaded payload over a stale fallback source snapshot', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [{
      ...entry(),
      envelope: 'uploaded-envelope',
      payloadVersion: 1,
      attachments: [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }],
    }],
    completedCanonicalMessageIds: [],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [{
      ...entry(),
      envelope: 'pre-upload-envelope',
      payloadVersion: 0,
      pendingAttachments: [{
        id: 'local_image',
        path: '/tmp/kordi/image.png',
        name: 'image.png',
        kind: 'image',
      }],
    }],
    completedCanonicalMessageIds: [],
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const [restored] = await restarted.restore();
    assert.equal(restored?.envelope, 'uploaded-envelope');
    assert.equal(restored?.pendingAttachments, undefined);
    assert.equal(restored?.attachments?.[0]?.attachmentId, 'att_uploaded');
  });
});

test('fallback reconciliation preserves the newest manual retry payload version', async () => {
  const pendingRetryEntry = {
    ...entry(),
    envelope: 'manual-retry-envelope',
    payloadVersion: 2,
    deliveryGeneration: 2,
    pendingRecipientIds: ['acct_b'],
    deliveredRecipientIds: ['acct_a'],
    attemptsByRecipientId: { acct_b: 0 },
    pendingAttachments: [{
      id: 'local_retry_image',
      path: '/tmp/kordi/retry.png',
      name: 'retry.png',
      kind: 'image' as const,
    }],
  };
  const previouslyUploadedEntry = {
    ...entry(),
    envelope: 'previous-upload-envelope',
    payloadVersion: 1,
    deliveryGeneration: 1,
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a'],
    exhaustedRecipientIds: ['acct_b'],
    attemptsByRecipientId: { acct_b: 6 },
    attachments: [{
      attachmentId: 'att_previous',
      name: 'previous.png',
      kind: 'image' as const,
    }],
  };

  for (const [indexedDbEntry, fallbackEntry] of [
    [previouslyUploadedEntry, pendingRetryEntry],
    [pendingRetryEntry, previouslyUploadedEntry],
  ] as const) {
    const events: string[] = [];
    const storage = new MemoryStorage(events);
    const indexedDb = new ControllableIndexedDb({
      version: 1,
      entries: [indexedDbEntry],
      completedCanonicalMessageIds: [],
    }, events);
    storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
      version: 1,
      entries: [fallbackEntry],
      completedCanonicalMessageIds: [],
    }));

    await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
      const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
      const [restored] = await restarted.restore();
      assert.equal(restored?.payloadVersion, 2);
      assert.equal(restored?.envelope, 'manual-retry-envelope');
      assert.equal(restored?.attachments, undefined);
      assert.equal(restored?.pendingAttachments?.[0]?.path, '/tmp/kordi/retry.png');
      assert.deepEqual(restored?.pendingRecipientIds, ['acct_b']);
      assert.deepEqual(restored?.deliveredRecipientIds, ['acct_a']);
      assert.equal(restored?.exhaustedRecipientIds, undefined);
      assert.deepEqual(restored?.attemptsByRecipientId, { acct_b: 0, acct_a: 0 });
    });
  }
});

test('restart reconciles a newer fallback delivery state before promoting it to IndexedDB', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: [],
  }, events);

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    indexedDb.failWrites = true;
    const first = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    await first.restore();
    await first.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });
    assert.equal(first.entries()[0]?.awaitingCanonicalAck, true);
    assert.equal(storage.length, 1, 'failed IDB write must retain the fallback snapshot');

    indexedDb.failWrites = false;
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const restored = await restarted.restore();
    assert.equal(restored[0]?.awaitingCanonicalAck, true);
    assert.deepEqual(restored[0]?.pendingRecipientIds, []);
    assert.deepEqual(restored[0]?.deliveredRecipientIds, ['acct_a', 'acct_b']);

    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0, 'recovery must not resend recipients already recorded as delivered');
    assert.equal(indexedDb.value?.entries[0]?.awaitingCanonicalAck, true);
    assert.equal(storage.length, 0, 'fallback is removed after the recovered snapshot reaches IDB');
    const idbWriteCompletedAt = events.indexOf('idb-put-complete');
    const fallbackRemovedAt = events.indexOf('storage-remove');
    assert.ok(
      idbWriteCompletedAt >= 0 && fallbackRemovedAt > idbWriteCompletedAt,
      'fallback cleanup must happen only after the IDB transaction completes',
    );
  });
});
