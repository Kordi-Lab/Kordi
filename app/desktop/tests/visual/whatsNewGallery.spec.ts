import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} What’s New window`, async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 720 });
    await page.goto(`/tests/visual/whatsNewGallery.html?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: /What’s New in Kordi/ })).toBeVisible();
    await expect(page).toHaveScreenshot(`whats-new-${theme}.png`);
  });
}
