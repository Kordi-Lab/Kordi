import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentImageWasReady, attachmentImageReadyDimensions, markAttachmentImageReady } from '../src/kordi-app/components/attachmentImageReadiness';

test('warm-image readiness retains bounded metadata without retaining inline payloads', () => {
  const payload = 'data:image/png;base64,' + 'A'.repeat(100_000);
  markAttachmentImageReady(payload, 640, 320);
  assert.equal(attachmentImageWasReady(payload), false);
  assert.equal(attachmentImageReadyDimensions(payload), null);
  for (let index = 0; index < 513; index += 1) markAttachmentImageReady(`attachment:metadata-${index}`, 640, 320);
  assert.equal(attachmentImageWasReady('attachment:metadata-0'), false);
  assert.deepEqual(attachmentImageReadyDimensions('attachment:metadata-512'), { widthPixels: 640, heightPixels: 320 });
});
