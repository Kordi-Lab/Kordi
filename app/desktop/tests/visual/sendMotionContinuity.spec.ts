import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

for (const count of [2, 50]) {
  for (const mode of ['text', 'burst', 'multiline', 'image', 'reduced'] as const) {
    test(`${mode} send in ${count}-message history has no reverse jump`, async ({ page }) => {
      if (mode === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/tests/visual/sendRenderBenchmark.html?count=${count}`);
      await expect(page.locator('[data-transcript-window-item]').last()).toBeVisible();
      if (mode === 'multiline') await page.getByRole('textbox', { name: 'Message' }).fill('line one\nline two\nline three\nline four\nline five');
      await page.waitForTimeout(350);
      const frames = await page.evaluate(async ({ count, mode }) => {
        const bench = (window as unknown as { sendRenderBench: { append(image?: boolean, text?: string): void; receipt(): void } }).sendRenderBench;
        const frames: Array<{ old: number | null; next: number | null; bubble: number | null; layout: number | null; gap: number | null }> = [];
        const sample = () => {
          const old = document.querySelector(`[data-index="${count - 1}"]`);
          const next = document.querySelector(`[data-index="${count}"]`);
          frames.push({ old: old?.getBoundingClientRect().top ?? null, next: next?.getBoundingClientRect().top ?? null,
            bubble: next?.querySelector('.app-message-bubble')?.getBoundingClientRect().top ?? null,
            layout: next ? next.getBoundingClientRect().top - (Number.parseFloat(getComputedStyle(next).translate.split(/\s+/)[1] ?? '0') || 0) : null,
            gap: old && next ? next.getBoundingClientRect().top - old.getBoundingClientRect().bottom : null });
        };
        sample();
        bench.append(mode === 'image', mode === 'multiline' ? 'Line one\nLine two\nLine three\nLine four\nLine five' : undefined);
        if (mode === 'burst') setTimeout(() => bench.append(), 45);
        setTimeout(() => bench.receipt(), 90);
        const start = performance.now();
        await new Promise<void>(resolve => {
          const tick = () => { sample(); if (performance.now() - start < 400) requestAnimationFrame(tick); else resolve(); };
          requestAnimationFrame(tick);
        });
        return frames;
      }, { count, mode });
      const tops = frames.flatMap(frame => frame.next === null ? [] : [frame.next]);
      expect(tops.length).toBeGreaterThan(5);
      for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeLessThanOrEqual(1);
      if (mode !== 'burst') {
        const layoutTops = frames.flatMap(frame => frame.layout === null ? [] : [frame.layout]);
        // Round compositor/readback precision before checking the one-pixel layout tolerance.
        expect(Math.round((Math.max(...layoutTops) - Math.min(...layoutTops)) * 100) / 100).toBeLessThanOrEqual(1);
      }
      for (const frame of frames) if (frame.gap !== null) expect(frame.gap).toBeGreaterThanOrEqual(-1);
      if (count === 2) {
        const oldTops = frames.flatMap(frame => frame.old === null ? [] : [frame.old]);
        expect(Math.max(...oldTops) - Math.min(...oldTops)).toBeLessThanOrEqual(1);
      }
    });
  }
}

test('sending while reading older history returns to the measured tail', async ({ page }) => {
  await page.goto('/tests/visual/sendRenderBenchmark.html?count=100');
  await expect(page.locator('[data-index="99"]')).toBeVisible();
  await page.locator('[data-virtual-transcript-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as { sendRenderBench: { append(): void } }).sendRenderBench.append());
  await expect(page.getByText('New message', { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  const distance = await page.locator('[data-virtual-transcript-scroll]').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(Math.abs(distance)).toBeLessThanOrEqual(1);
});
