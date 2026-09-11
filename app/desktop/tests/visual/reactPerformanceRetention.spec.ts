import { expect, test } from '@playwright/test';

test('React development timing history accumulates without retention cleanup', async ({ page }) => {
  await page.goto('/tests/visual/reactPerformanceRetention.html');
  await expect(page.locator('body')).toHaveAttribute('data-complete', 'true');
  const count = await page.evaluate(() => performance.getEntriesByType('measure').length);
  // Engines emit different React scheduler tracks; retained history must still accumulate.
  expect(count).toBeGreaterThan(20);
  console.log(`Unbounded synthetic timing records: ${count}`);
});

test('React timing cleanup releases backlog and later records while preserving app diagnostics', async ({ page }) => {
  await page.goto('/tests/visual/reactPerformanceRetention.html?bounded');
  await expect(page.locator('body')).toHaveAttribute('data-complete', 'true');
  const names = await page.evaluate(() => performance.getEntriesByType('measure').map(entry => entry.name));
  expect(names).toEqual(['kordi:synthetic-probe']);
});
