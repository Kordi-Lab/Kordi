import assert from 'node:assert/strict';
import test from 'node:test';
import { livePhotoAttachmentIds, normalizedLivePhoto, type LivePhoto } from '../src/features/chat/livePhotos';
import { cloudGroupAttachmentReferences } from '../src/features/cloud/cloudGroupAttachmentReferences';
import { cloudMessageAttachmentsFromRecord } from '../src/features/cloud/cloudGroupAttachmentCodec';
import { cloudMessageAttachmentMetadataOnly } from '../src/features/cloud/cloudMessageCache';
import { normalizedCloudGroupOutboxAttachments, normalizedCloudGroupOutboxPendingAttachments } from '../src/features/cloud/cloudGroupOutboxAttachmentCodec';
import { canonicalAttachments } from '../src/features/canonical/readModel/attachmentMapping';
import { parseStoredComposerAttachments, serializeStoredComposerAttachments } from '../src/features/chat/composerAttachments';
import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';
import type { AttachmentItem } from '../src/features/chat/composerController.types';

const livePhoto: LivePhoto = {
  video: { attachmentId: 'motion', name: 'Live.mov', mimeType: 'video/quicktime', sizeBytes: 200 },
  playback: { attachmentId: 'playback', name: 'Live.mp4', mimeType: 'video/mp4', sizeBytes: 300 },
};
const attachment = { attachmentId: 'still', kind: 'image' as const, name: 'photo.heic', mimeType: 'image/heic', sizeBytes: 100, livePhoto };
const draft: AttachmentItem = {
  id: 'draft', name: 'photo.heic', kind: 'image', path: '/tmp/live/photo.heic', mimeType: 'image/heic',
  sizeBytes: 100, previewUrl: 'data:image/jpeg;base64,cG9zdGVy',
  livePhotoFiles: { videoPath: '/tmp/live/motion.mov', playbackPath: '/tmp/live/playback.mp4' },
};

test('Live Photo survives group transport, canonical mapping, cache, and outbox reload as one photo', () => {
  assert.deepEqual(livePhotoAttachmentIds(attachment), ['still', 'motion', 'playback']);
  for (const result of [
    cloudGroupAttachmentReferences([attachment]),
    cloudMessageAttachmentsFromRecord([attachment]),
    [cloudMessageAttachmentMetadataOnly(attachment)],
    normalizedCloudGroupOutboxAttachments([attachment]),
    canonicalAttachments([attachment]),
  ]) {
    assert.equal(result?.length, 1);
    assert.deepEqual(result?.[0]?.livePhoto, livePhoto);
  }
  const restored = parseStoredComposerAttachments(serializeStoredComposerAttachments([draft]));
  assert.deepEqual(restored[0]?.livePhotoFiles, draft.livePhotoFiles);
  assert.deepEqual(normalizedCloudGroupOutboxPendingAttachments([draft])?.[0]?.livePhotoFiles, draft.livePhotoFiles);
  assert.equal(normalizedLivePhoto({ video: livePhoto.video }), undefined);
  assert.equal(normalizedLivePhoto({ ...livePhoto, playback: { ...livePhoto.playback, sizeBytes: -1 } }), undefined);
});

test('Live Photo cannot be sent until every upload finishes and metadata references all uploads', async () => {
  const calls: string[] = [];
  const nativeUpload = async ({ path }: { path: string }) => {
    calls.push(path);
    if (path.endsWith('.mp4')) throw new Error('motion upload interrupted');
    return { attachmentId: path, sizeBytes: 100, contentType: null };
  };
  const options = {
    token: 'test-token', attachments: [draft], useNativeUpload: true,
    client: { uploadAttachment: async () => { throw new Error('native path expected'); }, updateAttachmentPreview: async () => ({ attachmentId: 'photo', previewUrl: draft.previewUrl!, updatedLinks: 0 }) },
    nativeUpload, persistAttachmentPath: async () => null,
  };
  await assert.rejects(uploadComposerAttachments(options), /motion upload interrupted/);
  assert.deepEqual(calls, [draft.path, draft.livePhotoFiles!.videoPath, draft.livePhotoFiles!.playbackPath]);
  const sent = await uploadComposerAttachments({ ...options, nativeUpload: async ({ path }) => ({ attachmentId: path, sizeBytes: 100, contentType: null }) });
  assert.equal(sent.length, 1);
  assert.deepEqual(livePhotoAttachmentIds(sent[0]!), calls);
  assert.equal(sent[0]?.kind, 'image');
  assert.equal(sent[0]?.previewUrl, undefined);
});

test('cancelling a Live Photo between resource uploads prevents publication', async () => {
  const { trackLivePhotoUpload, cancelCloudAttachmentUpload } = await import('../src/features/cloud/cloudAttachmentUpload');
  const upload = trackLivePhotoUpload('/tmp/live/cancel-photo', ['/tmp/live/cancel-motion']);
  try {
    upload.check();
    await cancelCloudAttachmentUpload('/tmp/live/cancel-photo');
    assert.throws(() => upload.check(), /cancelled/);
  } finally { upload.finish(); }
});
