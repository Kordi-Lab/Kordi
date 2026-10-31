import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });
for (const owner of ['local', 'peer']) test(`${owner} reply handoff preserves its row and avoids overlap on every sampled frame`, async ({ page }) => {
  await page.goto(`/tests/visual/processingTrajectory.html?count=50&directHandoff=${owner}`);
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const frames = await page.evaluate(async () => {
    const driver = (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory;
    driver.step(1);
    await new Promise(resolve => setTimeout(resolve, 200));
    driver.step(2);
    await new Promise(resolve => setTimeout(resolve, 400));
    const row = document.querySelector<HTMLElement>('[data-index="51"]')!;
    const bubble = row?.querySelector('[data-transcript-message-root]');
    if (!row || !bubble) throw new Error('Expected pending reply');
    const samples: Array<{ mounted: boolean; overlap: number; progress: boolean; text: string }> = [];
    for (const phase of [3, 4, 5, 8, 10]) {
      driver.step(phase);
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(requestAnimationFrame);
        const current = document.querySelector<HTMLElement>('[data-index="51"]');
        const request = document.querySelector<HTMLElement>('[data-index="50"]')!;
        samples.push({ mounted: row === current && bubble === current?.querySelector('[data-transcript-message-root]'),
          overlap: request.getBoundingClientRect().bottom - (current?.getBoundingClientRect().top ?? 0),
          progress: Boolean(current?.querySelector('[role="status"]')), text: current?.textContent ?? '' });
      }
    }
    return samples;
  });
  expect(frames.every(frame => frame.mounted)).toBe(true);
  expect(Math.max(...frames.map(frame => frame.overlap))).toBeLessThanOrEqual(1);
  expect(frames.slice(0, 40).every(frame => frame.progress)).toBe(true);
  expect(frames.every(frame => !frame.text.includes('agentExchangeOutcome'))).toBe(true);
  await expect(page.locator('[data-index="51"]')).toContainText('Synthetic answer is ready.');
  const tailDistance = await page.locator('[data-virtual-transcript-scroll]').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(Math.abs(tailDistance)).toBeLessThanOrEqual(1);
});
