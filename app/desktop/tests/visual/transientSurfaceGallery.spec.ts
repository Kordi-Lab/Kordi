import { expect, test } from '@playwright/test';

const requiredSurfaces = [
  'start-chat',
  'composer-menu',
  'context-menu',
  'confirmation',
  'authentication',
  'updater',
  'group-management',
  'detached-auxiliary',
];

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} transient surface gallery`, async ({ page }) => {
    await page.goto(`/tests/visual/transientSurfaceGallery.html?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('[data-visual-ready="true"]')).toBeVisible();

    for (const surface of requiredSurfaces) {
      await expect(page.locator(`[data-visual-surface="${surface}"]`)).toBeVisible();
    }

    await expect(page.locator('[data-visual-gallery]')).toHaveScreenshot(`transient-surfaces-${theme}.png`);
  });
}
