import { expect, test } from '@playwright/test';

test('owner sees tools during a group request, including preparation between tool results', async ({ page }) => {
  await page.goto('/tests/visual/groupLiveTrajectory.html');
  await expect(page.locator('.app-agent-waiting-wave')).toBeVisible();
  await page.getByRole('button', { name: 'Tool progress' }).click();
  const timeline = page.locator('.app-transcript-tool-timeline');
  await expect(timeline).toBeVisible();
  await timeline.locator('.app-transcript-tool-timeline-summary').click();
  await expect(timeline.locator('.app-transcript-timeline-list')).toBeVisible();
  const node = await timeline.elementHandle();
  await page.getByRole('button', { name: 'Preparing next call' }).click();
  await expect(timeline.locator('.app-transcript-timeline-list')).toBeVisible();
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Local completion' }).click();
  await expect(page.getByText('Synthetic answer that remains visible through synchronization.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Public sync' }).click();
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  await expect(timeline.locator('.app-transcript-timeline-list')).toBeVisible();
});

test('a text-only reply keeps its shell and answer mounted across final public synchronization', async ({ page }) => {
  await page.goto('/tests/visual/groupLiveTrajectory.html?random=1');
  await expect(page.locator('.app-agent-waiting-wave')).toBeVisible();
  const card = await page.locator('.app-live-turn-card').elementHandle();
  await page.getByRole('button', { name: 'Answer text' }).click();
  await expect(page.locator('.app-live-assistant-answer')).toBeVisible();
  await page.evaluate(async () => { for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame); });
  const recording = page.evaluate(async () => {
    const nodes = ['.app-shell', '[data-testid="header"]', '[data-testid="composer"]', '.app-live-assistant-answer'].map(selector => document.querySelector(selector)!);
    const viewport = document.querySelector('[data-virtual-transcript-scroll]')!;
    const initialScroll = viewport.scrollTop;
    const samples = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      samples.push({ mounted: nodes.every(node => node.isConnected), scrollDelta: Math.abs(viewport.scrollTop - initialScroll) });
    }
    return samples;
  });
  await page.getByRole('button', { name: 'Local completion' }).click();
  await page.getByRole('button', { name: 'Public sync' }).click();
  const samples = await recording;
  expect(samples.every(sample => sample.mounted)).toBe(true);
  expect(Math.max(...samples.map(sample => sample.scrollDelta))).toBeLessThanOrEqual(1);
  expect(await card!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
});

test('peer group view never receives owner-local progress', async ({ page }) => {
  await page.goto('/tests/visual/groupLiveTrajectory.html?peer=1');
  for (const name of ['Tool progress', 'Preparing next call', 'Local completion', 'Public sync']) {
    await page.getByRole('button', { name }).click();
    await expect(page.locator('.app-transcript-tool-timeline')).toHaveCount(0);
  }
});

test('a pending reply shows a compact indicator and a quiet quote, and keeps its header in place', async ({ page }) => {
  await page.goto('/tests/visual/groupLiveTrajectory.html?random=1');
  const row = page.locator('[data-transcript-message-root]').filter({ has: page.locator('.app-live-turn-card') });
  const pending = row.locator('.app-live-turn-response-panel[data-live-turn-pending="true"]');
  await expect(pending.locator('.app-agent-waiting-wave')).toBeVisible();
  expect((await pending.boundingBox())!.width).toBeLessThan(80);
  await expect(row.locator('[data-agent-request-stop="header"]')).toBeVisible();
  await expect(row.locator('.app-source-message-quote')).toContainText('Synthetic Owner: @SyntheticAgent From now on');
  // The transcript stays pinned to its tail, so compare offsets inside the row.
  const offsets = () => row.evaluate((root) => ['.app-message-meta', '.app-live-turn-response-panel']
    .map((selector) => root.querySelector(selector)!.getBoundingClientRect().top - root.getBoundingClientRect().top));
  const pendingOffsets = await offsets();
  await page.getByRole('button', { name: 'Answer text' }).click();
  await expect(row.locator('.app-live-turn-response-panel')).not.toHaveAttribute('data-live-turn-pending', 'true');
  expect(await offsets()).toEqual(pendingOffsets);
});
