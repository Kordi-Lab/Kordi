import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireCloudAttachmentPreviewLease as acquire, retainCloudAttachmentPreviewResource as retain,
  clearCloudAttachmentPreviewCache as clear, cloudAttachmentPreviewCacheUsage as usage,
  CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES, CLOUD_ATTACHMENT_PREVIEW_IDLE_MS,
} from '../src/features/cloud/cloudAttachmentPreviewCache';
import { recoverAttachmentPreviewOnce as recover, recoveredAttachmentPreviewUrl, clearAttachmentPreviewRecoveryStateForTests } from '../src/kordi-app/components/transcriptAttachmentPreviewRecovery';
import type { MessageAttachment } from '../src/kordi-app/types';

const attachment = (id: string): MessageAttachment => ({ kind: 'image', name: 'Synthetic.png', attachmentId: id, sizeBytes: 100 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test.afterEach(clearAttachmentPreviewRecoveryStateForTests);

test('unused previews expire proactively, while an active lightbox lease survives', context => {
  clear();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const revoked: string[] = [];
  context.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  const card = acquire(retain('one', 'blob:synthetic', 1024));
  const lightbox = card.retain();
  card.release();
  context.mock.timers.tick(CLOUD_ATTACHMENT_PREVIEW_IDLE_MS * 2);
  assert.equal(usage().entries, 1);
  assert.deepEqual(revoked, []);
  lightbox.release();
  context.mock.timers.tick(CLOUD_ATTACHMENT_PREVIEW_IDLE_MS - 1);
  assert.equal(usage().entries, 1);
  context.mock.timers.tick(1);
  assert.deepEqual(usage(), { entries: 0, estimatedBytes: 0 });
  assert.deepEqual(revoked, ['blob:synthetic']);
});

test('recovered previews share the byte budget instead of accumulating in a second map', async () => {
  clearAttachmentPreviewRecoveryStateForTests();
  for (let index = 0; index < 30; index += 1) {
    await recover(attachment(`image:${index}`), {
      loadCloudSession: async () => ({ token: 'synthetic' }),
      recoverPreview: async () => 'data:image/png;base64,' + 'A'.repeat(100_000),
    });
    assert.ok(usage().estimatedBytes <= CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES);
  }
  assert.equal(recoveredAttachmentPreviewUrl('image:0'), null);
  assert.ok(recoveredAttachmentPreviewUrl('image:29'));
  assert.ok(usage().entries < 10);
});

test('one offscreen subscriber cannot abort another, but the final subscriber cancels recovery', async () => {
  clearAttachmentPreviewRecoveryStateForTests();
  let requestSignal: AbortSignal | undefined;
  let resolve!: (url: string) => void;
  let calls = 0;
  const deps = {
    loadCloudSession: async () => ({ token: 'synthetic' }),
    recoverPreview: async ({ signal }: { signal?: AbortSignal }) => { calls += 1; requestSignal = signal; return new Promise<string>(done => { resolve = done; }); },
  };
  const first = new AbortController(), second = new AbortController();
  const one = recover(attachment('shared'), { ...deps, signal: first.signal });
  const two = recover(attachment('shared'), { ...deps, signal: second.signal });
  await tick(); assert.equal(calls, 1);
  first.abort(); assert.equal(await one, null); assert.equal(requestSignal?.aborted, false);
  second.abort(); assert.equal(await two, null); assert.equal(requestSignal?.aborted, true);
  resolve('data:image/png;base64,late'); await tick();
  assert.equal(recoveredAttachmentPreviewUrl('shared'), null);
});

test('account reset prevents late recovery from repopulating the preview cache', async () => {
  clearAttachmentPreviewRecoveryStateForTests();
  let resolve!: (url: string) => void;
  const request = recover(attachment('stale-account'), {
    loadCloudSession: async () => ({ token: 'synthetic' }),
    recoverPreview: async () => new Promise<string>(done => { resolve = done; }),
  });
  await tick(); clear(); resolve('data:image/png;base64,stale');
  assert.equal(await request, null);
  assert.equal(usage().entries, 0);
});
