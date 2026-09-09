import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

test('sending an image updates the new bubble and its neighbor without repainting the text history', async ({ page }) => {
  await page.goto('/tests/visual/sendRenderBenchmark.html?count=2000');
  await expect(page.locator('[data-transcript-window-item]').first()).toBeVisible();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const bench = (window as unknown as { sendRenderBench: { reset(): void; append(image: boolean): void } }).sendRenderBench;
    bench.reset();
    bench.append(true);
  });
  await expect(page.getByText('New image', { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  const metrics = await page.evaluate(() => (window as unknown as { sendRenderBench: { metrics(): { bubbles: number; mountedRows: number } } }).sendRenderBench.metrics());
  expect(metrics.bubbles).toBeLessThanOrEqual(3);
  expect(metrics.bubbles).toBeGreaterThan(0);
  expect(metrics.mountedRows).toBeLessThan(80);
});

test('a receipt updates one bubble and composer typing updates none', async ({ page }) => {
  await page.goto('/tests/visual/sendRenderBenchmark.html?count=2000');
  await expect(page.locator('[data-transcript-window-item]').first()).toBeVisible();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const bench = (window as unknown as { sendRenderBench: { reset(): void; receipt(): void } }).sendRenderBench;
    bench.reset(); bench.receipt();
  });
  await page.waitForTimeout(250);
  const count = await page.evaluate(() => (window as unknown as { sendRenderBench: { metrics(): { bubbles: number } } }).sendRenderBench.metrics().bubbles);
  expect(count).toBe(1);
  await page.evaluate(() => (window as unknown as { sendRenderBench: { reset(): void } }).sendRenderBench.reset());
  await page.getByRole('textbox', { name: 'Message' }).fill('A new draft');
  const typing = await page.evaluate(() => (window as unknown as { sendRenderBench: { metrics(): { bubbles: number; transcripts: number } } }).sendRenderBench.metrics());
  expect(typing.bubbles).toBe(0);
  expect(typing.transcripts).toBe(0);
});
