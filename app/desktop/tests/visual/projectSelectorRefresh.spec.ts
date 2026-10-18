import { expect, test, type Page } from '@playwright/test';

const preview = '/tests/visual/projectSelectorRefresh.html';

async function rowState(page: Page) {
  const row = page.locator('.chat-workspace-selector-row');
  await expect(row).toHaveCount(1);
  const box = (await row.boundingBox())!;
  return { box, input: (await page.locator('[data-composer-input]').boundingBox())!.y };
}

for (const theme of ['light', 'dark']) {
  test(`cloud chat keeps a grayed workspace row in place across refreshes (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto(`${preview}?chat=cloud&theme=${theme}`);
    const row = page.getByRole('group', { name: 'Chat workspace', exact: true });
    const first = await rowState(page);
    for (let refresh = 1; refresh <= 4; refresh += 1) {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.locator('main')).toHaveAttribute('data-refresh', String(refresh));
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toHaveAttribute('title', 'Runs in Kordi Cloud');
      await expect(row).toHaveText('Local');
      await expect(row.getByRole('button')).toHaveCount(0);
      expect(Number(await row.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(1);
      expect(await rowState(page), `refresh ${refresh}: row and composer position`).toEqual(first);
    }
    await page.screenshot({ path: testInfo.outputPath(`project-selector-cloud-${theme}.png`) });
  });

  test(`local chat keeps its enabled workspace row in place across refreshes (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto(`${preview}?chat=local&theme=${theme}`);
    const project = page.getByRole('button', { name: 'Project: website', exact: true });
    await expect(project).toBeEnabled();
    const first = await rowState(page);
    for (let refresh = 1; refresh <= 4; refresh += 1) {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.locator('main')).toHaveAttribute('data-refresh', String(refresh));
      await expect(project).toBeEnabled();
      expect((await rowState(page)).input, `refresh ${refresh}: composer top`).toBe(first.input);
    }
    await page.screenshot({ path: testInfo.outputPath(`project-selector-local-${theme}.png`) });
  });
}
