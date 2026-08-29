import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import { voiceMessageSendFields } from '../src/features/chat/messageActions/optimisticAttachments';
import {
  cacheCloudAttachmentLocalPath,
  cachedCloudAttachmentLocalPath,
  clearCloudAttachmentLocalPathCache,
} from '../src/features/cloud/cloudAttachmentLocalPathCache';

test('composer uploads keep native file bytes out of JavaScript', async () => {
  let nativePath = '';
  const client = {
    async uploadAttachment() {
      throw new Error('native composer uploads must not use Blob transport');
    },
  } as unknown as Pick<CloudAuthClient, 'uploadAttachment'>;

  const result = await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'native-large-file',
      path: '/staged/Kordi.app.zip',
      name: 'Kordi.app.zip',
      kind: 'file',
      mimeType: 'application/zip',
      sizeBytes: 250 * 1024 * 1024,
    }],
    useNativeUpload: true,
    readAttachment: async () => {
      throw new Error('native composer uploads must not read bytes over Tauri IPC');
    },
    nativeUpload: async ({ path }) => {
      nativePath = path;
      return {
        attachmentId: 'att_native',
        objectKey: 'attachments/acct/att_native',
        sizeBytes: 250 * 1024 * 1024,
        contentType: 'application/zip',
        sha256Hex: 'a'.repeat(64),
        finalizedAt: '2026-08-18T00:00:00Z',
      };
    },
  });

  assert.equal(nativePath, '/staged/Kordi.app.zip');
  assert.equal(result[0]?.attachmentId, 'att_native');
  assert.equal(result[0]?.sizeBytes, 250 * 1024 * 1024);
});

test('video uploads require a prepared poster before bytes are sent', async () => {
  let uploaded = false;
  await assert.rejects(
    uploadComposerAttachments({
      token: 'kordi_cs_xyz',
      client: {} as Pick<CloudAuthClient, 'uploadAttachment'>,
      attachments: [{
        id: 'video-without-poster',
        path: '/staged/video.mp4',
        name: 'video.mp4',
        kind: 'file',
        mimeType: 'video/mp4',
      }],
      useNativeUpload: true,
      nativeUpload: async () => {
        uploaded = true;
        throw new Error('Video bytes must not upload without a poster.');
      },
    }),
    /could not prepare a poster/,
  );
  assert.equal(uploaded, false);
});

test('native upload completion wins the race with the final progress event', () => {
  const source = readFileSync(
    new URL('../src/features/cloud/cloudAttachmentUpload.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const result = await uploadDesktopCloudAttachment/);
  assert.match(source, /phase: 'complete',[\s\S]*uploadedBytes: totalBytes,[\s\S]*return result;/);
});

test('sticker sends use the durable sticker message kind', () => {
  assert.equal(voiceMessageSendFields([{
    id: 'sticker:/library/sticker.png',
    path: '/library/sticker.png',
    name: 'sticker.png',
    kind: 'image',
    subtype: 'sticker',
  }]).messageKind, 'sticker');
});

test('expressive media keeps one preview source after durable caching', async () => {
  clearCloudAttachmentLocalPathCache();
  try {
    const uploaded = await uploadComposerAttachments({
      token: 'kordi_cs_xyz',
      client: {} as Pick<CloudAuthClient, 'uploadAttachment'>,
      attachments: [{
        id: 'sticker:/library/sticker.png',
        path: '/library/sticker.png',
        name: 'sticker.png',
        kind: 'image',
        subtype: 'sticker',
        expressiveMedia: true,
        mimeType: 'image/png',
        sizeBytes: 3,
        widthPixels: 343,
        heightPixels: 361,
      }],
      useNativeUpload: true,
      nativeUpload: async () => ({
        attachmentId: 'att_sticker',
        objectKey: 'attachments/acct/att_sticker',
        sizeBytes: 3,
        contentType: 'image/png',
        sha256Hex: 'a'.repeat(64),
        finalizedAt: '2026-08-26T00:00:00Z',
      }),
      persistAttachmentPath: async (attachmentId) => {
        cacheCloudAttachmentLocalPath(attachmentId, '/cache/copied-sticker.png');
        return '/cache/copied-sticker.png';
      },
    });

    assert.equal(cachedCloudAttachmentLocalPath('att_sticker'), '/library/sticker.png');
    assert.equal(uploaded[0]?.subtype, undefined);
    assert.equal(uploaded[0]?.widthPixels, 343);
    assert.equal(uploaded[0]?.heightPixels, 361);
  } finally {
    clearCloudAttachmentLocalPathCache();
  }
});
