import { expect, test } from '@playwright/test';

test('native attachment downloads retain their MIME type and recover missing previews', async ({ page }) => {
  await page.goto('/tests/visual/cloudTransport.html');
  await expect(page.locator('#result')).toHaveText(JSON.stringify({
    mimeType: 'image/png', recovered: true, updates: 1,
  }));
});
