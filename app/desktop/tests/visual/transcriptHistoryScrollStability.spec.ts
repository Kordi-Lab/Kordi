import { expect, test } from '@playwright/test';

// A reader scrolling a long history must see the message content move at the
// same rate as the scrollbar. The transcript is virtualized with estimated row
// heights, so the first pass over a region measures each row and corrects the
// scroll position. When those corrections land during the gesture, the visible
// content jumps by the estimate error. This records the painted residual:
// `screenTop delta + scrollTop delta` should stay near zero.
test('a long history scrolls without shifting visible content', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryScrollStability.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 5000; });
  await page.waitForTimeout(200);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const viewportTop = element.getBoundingClientRect().top;
    const reference = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(row => row.getBoundingClientRect().top >= viewportTop + 1)!;
    const samples: Array<{ scrollTop: number; screenTop: number; connected: boolean }> = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const sample = () => {
      // Sample after paint so the recorded geometry matches what the user sees.
      requestAnimationFrame(() => setTimeout(() => {
        samples.push({
          scrollTop: element.scrollTop,
          screenTop: reference.getBoundingClientRect().top - viewportTop,
          connected: reference.isConnected,
        });
      }, 0));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  for (let step = 0; step < 40; step += 1) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(16);
  }
  const result = (await page.evaluate(() => (window as unknown as { __samples: Array<{ scrollTop: number; screenTop: number; connected: boolean }> }).__samples))
    .filter(sample => sample.connected);
  const residuals = result.slice(1).map((sample, index) => (
    sample.screenTop - result[index].screenTop + (sample.scrollTop - result[index].scrollTop)
  )).slice(1); // drop the first frame while the gesture starts
  const maxAbsResidual = Math.max(...residuals.map(Math.abs));
  expect(maxAbsResidual, JSON.stringify({ maxAbsResidual, residuals: residuals.filter(v => Math.abs(v) > 0.5).slice(0, 16) })).toBeLessThanOrEqual(2);
});
