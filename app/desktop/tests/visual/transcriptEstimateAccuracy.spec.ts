import { expect, test } from '@playwright/test';

test('estimates stay within a few pixels of rendered grouped, short, and emoji rows', async ({ page }) => {
  await page.goto('/tests/visual/transcriptEstimateAccuracy.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const result = await viewport.evaluate(async (element) => {
    const errors: Array<{ estimate: number; actual: number; grouped: string; text: string }> = [];
    for (let pass = 0; pass < 14; pass += 1) {
      for (const row of element.querySelectorAll<HTMLElement>('[data-transcript-window-item]')) {
        const inner = row.querySelector<HTMLElement>('[data-estimate]');
        if (!inner) continue;
        errors.push({
          estimate: Number(inner.dataset.estimate),
          actual: row.offsetHeight,
          grouped: `${row.dataset.index}`,
          text: (inner.textContent ?? '').slice(0, 8),
        });
      }
      element.scrollTop = pass % 2 === 0 ? element.scrollTop + 700 : element.scrollTop - 700;
      await new Promise(r => requestAnimationFrame(r));
    }
    const byKey = new Map<string, { estimate: number; actual: number; text: string }>();
    for (const error of errors) {
      const key = `${error.estimate}:${error.actual}`;
      if (!byKey.has(key)) byKey.set(key, error);
    }
    return [...byKey.values()].map(e => ({ est: e.estimate, actual: e.actual, err: e.actual - e.estimate, text: e.text }));
  });
  const maxAbsError = Math.max(...result.map(row => Math.abs(row.err)));
  expect(maxAbsError, JSON.stringify(result)).toBeLessThanOrEqual(4);
});
