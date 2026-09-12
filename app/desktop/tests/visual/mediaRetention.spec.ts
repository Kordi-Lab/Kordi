import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

let directory: string;
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'kordi-media-retention-'));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x200:r=15', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/media-retention.mp4`], { stdio: 'pipe' });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${directory}/media-retention.mp4`, '-t', '1', `${directory}/media-retention.gif`], { stdio: 'pipe' });
});

test.afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

test('static previews remain mounted while offscreen video releases its player', async ({ page }) => {
  await page.route('**/tests/visual/generated/media-retention.mp4', route => route.fulfill({ path: join(directory, 'media-retention.mp4'), contentType: 'video/mp4' }));
  await page.route('**/tests/visual/generated/media-retention.gif', route => route.fulfill({ path: join(directory, 'media-retention.gif'), contentType: 'image/gif' }));
  await page.goto('/tests/visual/mediaRetention.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-image-region] [data-transcript-media-active]')).toHaveAttribute('data-transcript-media-active', 'false');
  await viewport.evaluate(node => { node.scrollTop = 2250; });
  const image = page.locator('[data-leased-image]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(320);
  await page.getByRole('button', { name: 'Keep preview open' }).click();
  await page.getByRole('button', { name: 'Play Synthetic.mp4', exact: true }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(false);
  const imageHandle = await image.elementHandle();
  const actualImageHandle = await page.locator('[data-real-image] img').elementHandle();
  expect(await actualImageHandle!.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(320);
  const videoHandle = await video.elementHandle();
  const oldOffset = await page.locator('[data-after-media]').evaluate(node => node.getBoundingClientRect().top + node.parentElement!.scrollTop);
  await viewport.evaluate(node => { node.scrollTop = 0; });
  await expect(page.locator('[data-leased-image]')).toHaveCount(1);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.locator('[data-gif-region] img')).toHaveAttribute('src', /^data:image\/png/);
  await expect.poll(() => page.locator('[data-gif-region] img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await imageHandle!.evaluate(node => node.isConnected && node.hasAttribute('src'))).toBe(true);
  expect(await actualImageHandle!.evaluate(node => node.isConnected && node.hasAttribute('src'))).toBe(true);
  expect(await videoHandle!.evaluate(node => (node as HTMLVideoElement).paused && !node.hasAttribute('src'))).toBe(true);
  expect(await page.locator('[data-after-media]').evaluate(node => node.getBoundingClientRect().top + node.parentElement!.scrollTop)).toBeCloseTo(oldOffset, 0);
  await page.getByRole('button', { name: 'Evict cache' }).click();
  await expect.poll(() => page.locator('[data-borrowed-image]').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(320);
  await viewport.evaluate(node => { node.scrollTop = 2250; });
  await expect(page.locator('[data-leased-image]')).toBeVisible();
  await expect.poll(() => page.locator('[data-leased-image]').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(320);
  expect(await imageHandle!.evaluate(node => node === document.querySelector('[data-leased-image]'))).toBe(true);
  expect(await actualImageHandle!.evaluate(node => node === document.querySelector('[data-real-image] img'))).toBe(true);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('[data-leased-image]')).toHaveCount(1);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('[data-leased-image]')).toBeVisible();
});
