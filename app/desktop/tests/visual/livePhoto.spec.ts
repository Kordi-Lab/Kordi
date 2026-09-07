import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test.skip(process.platform !== 'darwin', 'The fixture uses native macOS PhotoKit validation.');
test.beforeAll(() => {
  execFileSync('bash', [fileURLToPath(new URL('../../../../scripts/prepare-live-photo-test-assets.sh', import.meta.url)),
    fileURLToPath(new URL('./generated/live-photo', import.meta.url))], { stdio: 'pipe' });
});

test('Live playback shares the photo frame, returns to still, and releases media when closed', async ({ page }) => {
  await page.goto('/tests/visual/livePhoto.html');
  await page.getByRole('button', { name: 'Play Live Photo' }).click();
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.1);
  const framesMatch = await page.evaluate(() => {
    const photo = document.querySelector('img')!.getBoundingClientRect();
    const video = document.querySelector('video')!.getBoundingClientRect();
    return photo.width === video.width && photo.height === video.height && photo.x === video.x && photo.y === video.y;
  });
  expect(framesMatch).toBe(true);
  await expect(page.locator('video')).toHaveCount(0);
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
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});
