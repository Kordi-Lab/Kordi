import { expect, test } from '@playwright/test';

const preview = '/tests/visual/projectSelectorRefresh.html';

for (const [chat, shown] of [['cloud', false], ['local', true]] as const) {
  for (const theme of ['light', 'dark']) {
    test(`${chat} chat keeps its project controls and composer in place across refreshes (${theme})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 900, height: 640 });
      await page.goto(`${preview}?chat=${chat}&theme=${theme}`);
      const controls = page.locator('.chat-workspace-controls');
      const input = page.locator('[data-composer-input]');
      await expect(input).toBeVisible();
      if (shown) await expect(page.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();
      const firstTop = (await input.boundingBox())!.y;
      for (let refresh = 1; refresh <= 4; refresh += 1) {
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(page.locator('main')).toHaveAttribute('data-refresh', String(refresh));
        await expect(controls).toHaveCount(shown ? 1 : 0);
        expect((await input.boundingBox())!.y, `refresh ${refresh}: composer top`).toBe(firstTop);
      }
      await page.screenshot({ path: testInfo.outputPath(`project-selector-${chat}-${theme}.png`) });
    });
  }
}
