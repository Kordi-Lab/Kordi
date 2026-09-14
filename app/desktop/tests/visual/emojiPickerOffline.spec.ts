import { expect, test } from '@playwright/test';

test('offline picker renders final artwork without per-emoji loading on first open or reopen', async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  let atlasRequests = 0;
  const atlasLoads: string[] = [];
  page.on('request', request => {
    if (/atlas-[0-3].*\.webp/.test(request.url())) {
      atlasRequests += 1;
      atlasLoads.push(`${request.resourceType()}: ${new URL(request.url()).pathname.split('/').pop()}`);
    }
  });
  await page.goto('/tests/visual/emojiPickerOffline.html');
  await expect(page.locator('html')).toHaveAttribute('data-emoji-sheets', 'ready');
  expect(atlasRequests, atlasLoads.join(', ')).toBe(4);
  await page.getByRole('button', { name: 'Open picker', exact: true }).click();
  const grid = page.getByRole('listbox', { name: 'Noto Emoji', exact: true });
  await expect(grid.locator('.app-noto-thumbnail')).toHaveCount(881);
  await expect(grid.locator('.app-noto-fallback')).toHaveCount(0);
  await expect(grid.locator('img')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-noto-requests');
  const first = grid.locator('.app-noto-thumbnail').first();
  const initialSize = await first.boundingBox();
  await expect(page.getByTestId('picker')).toHaveScreenshot('offline-noto-picker.png');
  await page.getByRole('button', { name: 'Close picker', exact: true }).click();
  await page.getByRole('button', { name: 'Open picker', exact: true }).click();
  await expect(grid.locator('.app-noto-fallback')).toHaveCount(0);
  expect(await first.boundingBox()).toEqual(initialSize);
  expect(atlasRequests, atlasLoads.join(', ')).toBe(4);
  await expect(page.locator('html')).not.toHaveAttribute('data-noto-requests');
  await expect(page.getByTestId('picker')).toHaveScreenshot('offline-noto-picker.png');
});
