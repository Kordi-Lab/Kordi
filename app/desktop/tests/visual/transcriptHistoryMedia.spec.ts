import { expect, test } from '@playwright/test';

const image = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="#537fab"/></svg>';

test('upward scrolling measures image and quote rows before displaying them', async ({ page }) => {
  // Native resize delivery may trail a scroll commit. Correct first-frame row
  // positions must not depend on the observer arriving before the next paint.
  await page.addInitScript(() => {
    const NativeObserver = ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => { setTimeout(() => callback(entries, observer), 40); });
      }
    };
  });
  await page.route('**/synthetic-history/*.svg', async route => {
    await new Promise(resolve => setTimeout(resolve, 120));
    await route.fulfill({ contentType: 'image/svg+xml', body: image });
  });
  await page.goto('/tests/visual/transcriptHistoryScrollStability.html?pane&media');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 14000; });
  await page.waitForTimeout(500);
  await viewport.evaluate(element => {
    const gaps: number[] = [];
    const writes: number[] = [];
    const scrollTo = element.scrollTo.bind(element);
    element.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      writes.push(typeof options === 'number' ? y ?? 0 : options?.top ?? 0);
      if (typeof options === 'number') scrollTo(options, y ?? 0);
      else scrollTo(options);
    };
    Object.assign(window, { mediaRowGaps: gaps, mediaScrollWrites: writes });
    const sample = () => {
      const viewport = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
        .map(row => row.getBoundingClientRect())
        .filter(row => row.bottom > viewport.top && row.top < viewport.bottom);
      for (let i = 1; i < rows.length; i += 1) gaps.push(rows[i].top - rows[i - 1].bottom);
      // A delayed range commit can also flash a blank strip at either edge.
      gaps.push(rows.length ? Math.max(0, rows[0].top - viewport.top,
        viewport.bottom - rows[rows.length - 1].bottom) : viewport.height);
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    sample();
  });
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 10; step += 1) {
    await page.mouse.wheel(0, -1000);
    await page.waitForTimeout(80);
  }
  const gaps = await page.evaluate(() => (window as unknown as { mediaRowGaps: number[] }).mediaRowGaps);
  expect(gaps.length).toBeGreaterThan(50);
  expect(Math.max(...gaps.map(Math.abs)), JSON.stringify(gaps.filter(gap => Math.abs(gap) > 1))).toBeLessThanOrEqual(1);
  // DOM rectangles alone cannot expose native compositor jitter: a sequence of
  // scrollTo corrections can fight wheel momentum while those rectangles agree.
  expect(await page.evaluate(() => (window as unknown as { mediaScrollWrites: number[] }).mediaScrollWrites)).toEqual([]);

  const readingPoint = await viewport.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
      .find(row => row.getBoundingClientRect().bottom > top)!;
    return { index: row.dataset.index!, top: row.getBoundingClientRect().top };
  });
  await page.waitForTimeout(400);
  expect(Math.abs(await page.locator(`[data-transcript-window-item][data-index="${readingPoint.index}"]`)
    .evaluate(element => element.getBoundingClientRect().top) - readingPoint.top)).toBeLessThanOrEqual(1);
});

test('image decoding preserves reserved row height', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/synthetic-history/*.svg', async route => {
    await pending;
    await route.fulfill({ contentType: 'image/svg+xml', body: image });
  });
  await page.goto('/tests/visual/transcriptHistoryScrollStability.html?pane&media');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const row = page.locator('[data-transcript-window-item]').filter({ has: page.locator('img[alt="Synthetic image 297"]') });
  await expect(row).toBeVisible();
  const before = await row.evaluate(element => element.getBoundingClientRect().height);
  release();
  await expect(row.locator('img')).toHaveAttribute('data-attachment-image-loaded', 'true');
  await page.waitForTimeout(250);
  const after = await row.evaluate(element => element.getBoundingClientRect().height);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

test('late row resizes preserve the reading point without interrupting a wheel gesture', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryScrollStability.html?pane');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 8000; });
  await page.waitForTimeout(400);
  for (const delta of [80, -40]) {
    const before = await viewport.evaluate((element, delta) => {
      const edge = element.getBoundingClientRect().top;
      const rows = [...element.querySelectorAll<HTMLElement>('[data-transcript-window-item]')];
      const visible = rows.findIndex(row => row.getBoundingClientRect().bottom > edge);
      const anchor = rows[visible];
      const above = rows[visible - 2];
      const result = { index: anchor.dataset.index!, top: anchor.getBoundingClientRect().top, offset: element.scrollTop };
      // Keep the viewport still so the only possible movement is caused by
      // asynchronous content sizing, such as decoding an above-screen image.
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      above.style.height = `${above.offsetHeight + delta}px`;
      return result;
    }, delta);
    await page.waitForTimeout(100);
    const anchor = page.locator(`[data-transcript-window-item][data-index="${before.index}"]`);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(before.offset);
    expect(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - before.top)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(350);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(before.offset + delta);
    expect(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - before.top)).toBeLessThanOrEqual(1);
  }
});
