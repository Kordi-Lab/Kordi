import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test.skip(process.platform !== 'darwin', 'The fixture uses native macOS PhotoKit validation.');
test.beforeAll(() => {
  execFileSync('bash', [fileURLToPath(new URL('../../../../scripts/prepare-live-photo-test-assets.sh', import.meta.url)),
    fileURLToPath(new URL('./generated/live-photo', import.meta.url))], { stdio: 'pipe' });
});

test('Live playback shares the photo frame, returns to still, and releases media when closed', async ({ page }) => {
  await page.goto('/tests/visual/livePhoto.html?delayed-photo');
  await expect(page.getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.1);
  const framesMatch = await page.evaluate(() => {
    const photo = document.querySelector('img')!.getBoundingClientRect();
    const video = document.querySelector('video')!.getBoundingClientRect();
    return photo.width === video.width && photo.height === video.height && photo.x === video.x && photo.y === video.y;
  });
  expect(framesMatch).toBe(true);
  await expect(page.locator('video')).toBeHidden();
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await expect(page.locator('video')).toHaveCount(1);
  const video = await page.locator('video').elementHandle();
  await page.getByRole('button', { name: 'Close preview' }).click();
  expect(await video!.evaluate((element) => (element as HTMLVideoElement).paused && !element.hasAttribute('src'))).toBe(true);
});

test('failed Live playback keeps the still visible and offers retry', async ({ page }) => {
  await page.goto('/tests/visual/livePhoto.html?failure');
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await expect(page.getByRole('status')).toHaveText('Live playback unavailable. Try again.');
  await expect(page.getByRole('img')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play Live Photo' })).toBeEnabled();
});

test('buffering keeps the still visible and can be stopped', async ({ page }) => {
  await page.route('**/live-photo.mp4', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto('/tests/visual/livePhoto.html');
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await expect(page.locator('video')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: 'Stop Live Photo' }).click();
  await expect(page.locator('video')).toBeHidden();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 3);
  expect(await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);
  await expect(page.getByRole('status')).toHaveCount(0);
});


test('replay uses the same buffered video without preparing another source', async ({ page }) => {
  await page.goto('/tests/visual/livePhoto.html?slow-source');
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.1);
  const video = await page.locator('video').elementHandle();
  await expect(page.locator('video')).toBeHidden();
  await page.route('**/live-photo.mp4', (route) => route.abort());
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && !video.paused && video.currentTime > 0.1;
  });
  expect(await video!.evaluate((element) => element === document.querySelector('video'))).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-live-source-requests', '1');
  await expect(page.getByRole('status')).toHaveCount(0);
});


test('a restored Live Photo draft recovers its local preview before uploading', async ({ page }) => {
  await page.goto('/tests/visual/livePhoto.html');
  const result = await page.evaluate(async () => {
    const { parseStoredComposerAttachments, serializeStoredComposerAttachments } = await import('/src/features/chat/composerAttachments.ts');
    const { uploadComposerAttachments } = await import('/src/features/cloud/cloudComposerAttachments.ts');
    const draft = { id: 'draft', name: 'Photo.heic', kind: 'image', path: '/tmp/photo.heic', mimeType: 'image/heic', sizeBytes: 100,
      livePhotoFiles: { videoPath: '/tmp/motion.mov', playbackPath: '/tmp/playback.mp4', previewPath: '/tmp/preview.jpg' } };
    const restored = parseStoredComposerAttachments(serializeStoredComposerAttachments([draft]));
    const reads: string[] = [];
    let previewStored = false;
    const sent = await uploadComposerAttachments({ token: 'test-token', attachments: restored, useNativeUpload: true,
      readAttachment: async (path: string) => {
        reads.push(path);
        const bytes = await (await fetch('/tests/visual/generated/live-photo/live-photo.jpg')).arrayBuffer();
        return Array.from(new Uint8Array(bytes));
      },
      client: {
        uploadAttachment: async () => { throw new Error('Native upload expected'); },
        updateAttachmentPreview: async (_token: string, _id: string, preview: string) => {
          previewStored = preview.startsWith('data:image/jpeg;base64,');
          return { attachmentId: 'photo', previewUrl: preview, updatedLinks: 0 };
        },
      },
      nativeUpload: async ({ path }: { path: string }) => ({ attachmentId: path, sizeBytes: 100, contentType: null }),
      persistAttachmentPath: async () => null,
    });
    return { reads, previewStored, hasLivePhoto: Boolean(sent[0]?.livePhoto), count: sent.length };
  });
  expect(result).toEqual({ reads: ['/tmp/preview.jpg'], previewStored: true, hasLivePhoto: true, count: 1 });
});
