import { expect, test } from '@playwright/test';

test('tool-only group completion keeps the execution section and viewport stable through public sync', async ({ page }) => {
  await page.goto('/tests/visual/groupExecutionHandoff.html');
  const timeline = page.locator('.app-transcript-tool-timeline');
  await expect(timeline).toBeVisible();
  await timeline.locator('.app-transcript-tool-timeline-summary').click();
  await page.getByRole('button', { name: 'Local completion' }).click();
  await expect(timeline.locator('.app-transcript-timeline-list')).toBeVisible();
  await page.evaluate(async () => { for (let i = 0; i < 25; i++) await new Promise(requestAnimationFrame); });
  const recording = page.evaluate(async () => {
    const nodes = ['.app-shell', '[data-testid="sidebar"]', '[data-testid="header"]', '[data-testid="composer"]', '.app-transcript-tool-timeline']
      .map(selector => document.querySelector(selector)!);
    const viewport = document.querySelector('[data-virtual-transcript-scroll]')!;
    const initialScroll = viewport.scrollTop;
    const samples: Array<{ mounted: boolean; scrollDelta: number }> = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      samples.push({ mounted: nodes.every(node => node.isConnected), scrollDelta: Math.abs(viewport.scrollTop - initialScroll) });
    }
    return { initialScroll, samples };
  });
  await page.getByRole('button', { name: 'Public sync' }).click();
  const { initialScroll, samples } = await recording;
  expect(initialScroll).toBeGreaterThan(100);
  expect(samples.every(sample => sample.mounted)).toBe(true);
  expect(Math.max(...samples.map(sample => sample.scrollDelta))).toBeLessThanOrEqual(1);
  await expect(timeline.locator('.app-transcript-timeline-list')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
});

test('peer group view never mounts private tool details', async ({ page }) => {
  await page.goto('/tests/visual/groupExecutionHandoff.html?peer=1');
  await expect(page.getByText('Public answer', { exact: true })).toBeVisible();
  await expect(page.locator('.app-transcript-tool-timeline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Local completion' }).click();
  await expect(page.locator('.app-transcript-tool-timeline')).toHaveCount(0);
});
