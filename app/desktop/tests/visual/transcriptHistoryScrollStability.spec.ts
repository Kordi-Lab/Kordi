import { expect, test } from '@playwright/test';

// Estimates cannot predict every Markdown, attachment, or wrapped text height.
// Track a visible message against wheel input, not against scrollTop: both the
// layout and scroll offset legitimately change together when rows are measured.
for (const mixed of [false, true]) test(`${mixed ? 'Mixed-height' : 'Short grouped'} history follows the gesture across newly measured rows`, async ({ page }) => {
  await page.goto(`/tests/visual/transcriptHistoryScrollStability.html${mixed ? '?mixed=1' : ''}`);
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate((element, offset) => { element.scrollTop = offset; }, mixed ? 18000 : 5000);
  await page.waitForTimeout(250);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const errors: number[] = [];
  for (let step = 0; step < 50; step += 1) {
    const before = await viewport.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(row => row.getBoundingClientRect().bottom > top + 100)!;
      return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    });
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(80);
    const after = await page.locator(`[data-message-id="${before.id}"]`).evaluate(element => element.getBoundingClientRect().top);
    errors.push(after - before.top - 80);
  }
  expect(Math.max(...errors.map(Math.abs)), JSON.stringify(errors)).toBeLessThanOrEqual(2);
});

test('mixed-height rows do not reverse direction between gesture frames', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryScrollStability.html?mixed=1');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 18000; });
  await page.waitForTimeout(250);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const deltas: number[] = [];
    Object.assign(window, { gestureDeltas: deltas });
    let previous = new Map<string, number>();
    const sample = () => {
      const bounds = viewport.getBoundingClientRect();
      const current = new Map([...viewport.querySelectorAll<HTMLElement>('[data-message-id]')]
        .filter(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom)
        .map(row => [row.dataset.messageId!, row.getBoundingClientRect().top]));
      for (const [id, top] of current) {
        const prior = previous.get(id);
        if (prior !== undefined) { deltas.push(top - prior); break; }
      }
      previous = current;
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    sample();
  });
  for (let step = 0; step < 100; step += 1) {
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(16);
  }
  const deltas = await page.evaluate(() => (window as unknown as { gestureDeltas: number[] }).gestureDeltas);
  expect(deltas.length).toBeGreaterThan(20);
  expect(Math.min(...deltas), JSON.stringify(deltas)).toBeGreaterThanOrEqual(-1);
  expect(Math.max(...deltas), JSON.stringify(deltas)).toBeLessThanOrEqual(160);
});

for (const mixed of [false, true]) test(`slow downward scrolling preserves painted motion (${mixed ? 'mixed' : 'short'})`, async ({ page }) => {
  await page.goto(`/tests/visual/transcriptHistoryScrollStability.html?pane=1${mixed ? '&mixed=1' : ''}`);
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 3000; });
  await page.waitForTimeout(250);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const deltas: number[] = [];
    Object.assign(window, { downwardDeltas: deltas });
    let previous = new Map<string, number>();
    const sample = () => {
      const bounds = viewport.getBoundingClientRect();
      const current = new Map([...viewport.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
        .filter(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom)
        .map(row => [row.dataset.index!, row.getBoundingClientRect().top]));
      for (const [id, top] of current) {
        const prior = previous.get(id);
        if (prior !== undefined) deltas.push(top - prior);
      }
      previous = current;
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    sample();
  });
  for (let step = 0; step < 200; step += 1) {
    await page.mouse.wheel(0, 8);
    await page.waitForTimeout(25);
  }
  const deltas = await page.evaluate(() => (window as unknown as { downwardDeltas: number[] }).downwardDeltas);
  expect(deltas.length).toBeGreaterThan(50);
  expect(Math.max(...deltas), JSON.stringify(deltas.filter(value => value > 1))).toBeLessThanOrEqual(1);
  expect(Math.min(...deltas), JSON.stringify(deltas.filter(value => value < -16))).toBeGreaterThanOrEqual(-16);
});
