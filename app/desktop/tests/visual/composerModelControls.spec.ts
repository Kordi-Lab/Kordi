import { expect, test } from '@playwright/test';

for (const width of [1100, 500, 360]) {
  for (const theme of ['light', 'dark']) {
    test(`compact model and effort at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/tests/visual/composerModelControls.html?palette=sand&theme=${theme}`);
      const pill = page.locator('.app-model-effort-pill');
      await expect(pill.locator(':scope > button')).toHaveCount(2);
      await page.getByRole('button', { name: 'Adjust effort, current Medium' }).click();
      const menu = page.getByRole('dialog', { name: 'Thinking effort' });
      await expect(menu).toBeVisible();
      // Measure once the enter animation has settled its scale.
      await expect.poll(async () => (await menu.boundingBox())!.width).toBe(232);
      await expect(menu).not.toContainText('More effort');
      const slider = menu.getByRole('slider', { name: 'Thinking effort' });
      await slider.focus(); await slider.press('End');
      await expect(page.getByRole('button', { name: 'Adjust effort, current Extra high' })).toBeVisible();
      await menu.getByRole('button', { name: 'Reset effort to model default' }).click();
      await expect(page.getByRole('button', { name: 'Adjust effort, current Default' })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Select model, current GPT-6 Sol' }).click();
      await page.getByRole('button', { name: 'A much longer model display name' }).click();
      const bounds = await pill.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`model-effort-${width}-${theme}.png`) });
    });
  }
}
