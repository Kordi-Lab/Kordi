import { expect, test } from '@playwright/test';

// Scrolling up near the top starts an older page while the gesture is active.
// Older rows are inserted above the reader, so the scroll position is adjusted
// to hold the reading spot. The visible row must keep moving smoothly downward
// with the gesture; a sudden jump or reversal is the jitter.
test('loading older pages while scrolling keeps visible motion smooth', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryLoading.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 1400; });
  await page.waitForTimeout(200);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const viewportTop = element.getBoundingClientRect().top;
    const reference = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(row => row.getBoundingClientRect().top >= viewportTop + 1)!;
    const samples: Array<{ screenTop: number; connected: boolean }> = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const sample = () => {
      requestAnimationFrame(() => setTimeout(() => {
        samples.push({
          screenTop: reference.getBoundingClientRect().top - viewportTop,
          connected: reference.isConnected,
        });
      }, 0));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  for (let step = 0; step < 120; step += 1) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(16);
  }
  const result = (await page.evaluate(() => (window as unknown as { __samples: Array<{ screenTop: number; connected: boolean }> }).__samples))
    .filter(sample => sample.connected);
  const deltas = result.slice(1).map((sample, index) => sample.screenTop - result[index].screenTop).slice(1);
  const reversals = deltas.filter(delta => delta < -1).length;
  const maxDelta = Math.max(...deltas);
  // Scrolling up moves content down (positive deltas). A reversal or a jump far
  // beyond the wheel step means the prepend moved the reader.
  expect(reversals, JSON.stringify({ reversals, maxDelta, deltas: deltas.map(d => Math.round(d)) })).toBe(0);
  expect(maxDelta, JSON.stringify({ reversals, maxDelta, deltas: deltas.map(d => Math.round(d)) })).toBeLessThanOrEqual(80);
});
