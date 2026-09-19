import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`file attachment chip renders across bubble contexts (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/fileAttachmentChip.html?theme=${theme}`);
    await expect(page.locator('[data-file-attachment-chip-fixture="true"]')).toBeVisible();
    await expect(page.locator('[data-attachment-file-chip="true"]')).toHaveCount(9);
    await expect(page).toHaveScreenshot(`fileAttachmentChip-${theme}.png`, { fullPage: true });
  });
}
