import { expect, test } from '@playwright/test';

const fixture = '/tests/visual/threadDates.html';
test.use({ timezoneId: 'UTC' });

test('Threads has one ruled date divider per local day and time-only message headers', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`${fixture}?theme=${theme}`);
    await expect(page.locator('[data-transcript-date-divider]')).toHaveText(['October 2, 2026', 'October 3, 2026']);
    await expect(page.locator('[data-transcript-time-separator]')).toHaveCount(0);
    await expect(page.locator('.app-thread-message-time')).toHaveText(['09:00', '18:00', '00:01', '00:02']);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const divider = page.locator('[data-transcript-date-divider]').first();
      await expect(divider).toBeVisible();
      for (const rule of await divider.locator('span').all()) {
        const bounds = await rule.boundingBox();
        expect(bounds!.width).toBeGreaterThan(8);
        expect(bounds!.height).toBe(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.locator('#app-transcript-message-date-quote .app-source-message-quote').click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'navigate:date-first');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('[data-transcript-date-divider]')).toHaveCount(0);
  await expect(page.locator('[data-transcript-time-separator]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator('[data-transcript-date-divider]')).toHaveCount(2);
});

test('day dividers and message times use the viewer timezone together', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', baseURL });
  try {
    const page = await context.newPage();
    await page.goto(fixture);
    await expect(page.locator('[data-transcript-date-divider]')).toHaveText(['October 2, 2026']);
    await expect(page.locator('.app-thread-message-time')).toHaveText(['02:00', '11:00', '17:01', '17:02']);
  } finally { await context.close(); }
});
