import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  for (const state of ['local', 'uploaded', 'public'] as const) {
    test(`document reader renders the ${state} state (${theme})`, async ({ page }) => {
      await page.goto(`/tests/visual/documentReader.html?state=${state}&theme=${theme}`);
      await expect(page.locator(`[data-document-reader-fixture="${state}"]`)).toBeVisible();
      await expect(page.locator('.app-document-title').first()).toHaveText('Kordi related work');
      await expect(page).toHaveScreenshot(`documentReader-${state}-${theme}.png`, { fullPage: true });
    });
  }
}
