import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ reducedMotion: 'no-preference' });
for (const count of [2, 50]) test(`record complete processing entry with ${count} prior messages`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/tests/visual/processingTrajectory.html?count=${count}`);
  await expect(page.locator('[data-transcript-window-item]').last()).toBeVisible();
  await page.waitForTimeout(350);
  const frames = await page.evaluate(async count => {
    const driver = (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory;
    const nodes = ['.app-shell', '[data-testid="sidebar"]', '[data-testid="header"]', '[data-testid="composer"]'].map(selector => document.querySelector(selector)!);
    const frames: Array<Record<string, unknown>> = [];
    const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const plan = [[0, 1], [120, 2], [300, 3], [550, 4], [800, 5], [1100, 6], [1450, 7], [1800, 8], [2200, 9], [2600, 10]];
    const start = performance.now(); let next = 0;
    await new Promise<void>(resolve => {
      const tick = () => {
        const elapsed = performance.now() - start;
        while (next < plan.length && elapsed >= plan[next][0]) driver.step(plan[next++][1]);
        const old = document.querySelector<HTMLElement>(`[data-index="${count - 1}"]`);
        const response = document.querySelector<HTMLElement>(`[data-index="${count + 1}"]`);
        frames.push({ elapsed: Math.round(elapsed), phase: document.querySelector('[data-testid="phase"]')?.textContent, nodesMounted: nodes.every(node => node.isConnected),
          scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, viewportHeight: viewport.clientHeight, documentScroll: document.scrollingElement?.scrollTop,
          rows: document.querySelectorAll('[data-transcript-window-item]').length, historyTop: old?.getBoundingClientRect().top, historyAnimating: (old?.getAnimations().length ?? 0) > 0,
          responseTop: response?.getBoundingClientRect().top, responseHeight: response?.offsetHeight, viewportTop: viewport.getBoundingClientRect().top,
          shellHeight: nodes[0].getBoundingClientRect().height });
        if (elapsed < 3100) requestAnimationFrame(tick); else resolve();
      }; requestAnimationFrame(tick);
    });
    return frames;
  }, count);
  await writeFile(info.outputPath('trajectory.json'), JSON.stringify(frames, null, 2));
  const changes = frames.slice(1).map((frame, i) => ({ phase: frame.phase, at: frame.elapsed, delta: Number(frame.historyTop) - Number(frames[i].historyTop), scrollDelta: Number(frame.scrollTop) - Number(frames[i].scrollTop), rows: frame.rows }));
  await writeFile(info.outputPath('summary.json'), JSON.stringify({ count, largestMovements: [...changes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12) }));
  expect(frames.every(frame => frame.nodesMounted)).toBe(true);
  expect(errors).toEqual([]);
  expect(frames.every(frame => frame.documentScroll === 0 && frame.viewportTop === frames[0].viewportTop && frame.shellHeight === frames[0].shellHeight)).toBe(true);
  if (count === 2) expect(Math.max(...frames.map(frame => Number(frame.historyTop))) - Math.min(...frames.map(frame => Number(frame.historyTop)))).toBeLessThanOrEqual(1);
  if (count === 50) {
    const processing = changes.filter(change => change.phase === 'processing');
    const displacement = Math.abs(processing.reduce((sum, change) => sum + change.delta, 0));
    expect(frames.some(frame => frame.phase === 'processing' && frame.historyAnimating)).toBe(true);
    // At both 60 Hz and 120 Hz, no single paint should consume the whole move.
    expect(Math.max(...processing.map(change => Math.abs(change.delta)))).toBeLessThan(displacement * 0.95);
    const settledAnswer = frames.filter(frame => Number(frame.elapsed) >= 2050 && Number(frame.elapsed) <= 2150);
    expect(settledAnswer.length).toBeGreaterThan(0);
    for (const frame of settledAnswer) expect(Math.abs(Number(frame.scrollHeight) - Number(frame.viewportHeight) - Number(frame.scrollTop))).toBeLessThanOrEqual(1);
  }
});

test('processing and tool growth preserve the reading point above the tail', async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=100');
  await expect(page.locator('[data-transcript-window-item]').last()).toBeVisible();
  const step = (phase: number) => page.evaluate(phase => (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory.step(phase), phase);
  await step(1);
  await page.waitForTimeout(200);
  await step(2);
  await page.waitForTimeout(250);
  await page.locator('[data-virtual-transcript-scroll]').evaluate(element => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    element.scrollTop -= 400;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const anchor = await page.evaluate(() => {
    const viewport = document.querySelector('[data-virtual-transcript-scroll]')!;
    const top = viewport.getBoundingClientRect().top;
    const row = [...viewport.querySelectorAll<HTMLElement>('[data-transcript-window-item]')].find(row => row.getBoundingClientRect().bottom > top)!;
    return { index: row.dataset.index, top: row.getBoundingClientRect().top, scrollTop: viewport.scrollTop };
  });
  for (const phase of [3, 4, 5, 6, 7, 8, 9, 10]) {
    await step(phase);
    await page.waitForTimeout(180);
    const position = await page.locator(`[data-index="${anchor.index}"]`).evaluate(element => element.getBoundingClientRect().top);
    expect(Math.abs(position - anchor.top)).toBeLessThanOrEqual(1);
  }
});

test('reduced motion keeps measured processing layout without row animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/visual/processingTrajectory.html?count=50');
  await expect(page.locator('[data-transcript-window-item]').last()).toBeVisible();
  for (const phase of [1, 2, 3, 4, 5, 6, 8, 9, 10]) {
    await page.evaluate(phase => (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory.step(phase), phase);
    await page.waitForTimeout(120);
    const state = await page.locator('[data-virtual-transcript-scroll]').evaluate(element => ({
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      rowAnimations: [...element.querySelectorAll('[data-transcript-window-item]')].flatMap(row => row.getAnimations()).length,
    }));
    expect(Math.abs(state.distance)).toBeLessThanOrEqual(1);
    expect(state.rowAnimations).toBe(0);
  }
});

test('direct processing entry stays gradual across a 40ms native frame gap', async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=50');
  await expect(page.locator('[data-transcript-window-item]').last()).toBeVisible();
  await page.waitForTimeout(250);
  const samples = await page.evaluate(async () => {
    const driver = (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory;
    driver.step(1);
    await new Promise(resolve => setTimeout(resolve, 220));
    driver.step(3); // Direct admission has no intervening queued-bubble layout.
    const row = document.querySelector<HTMLElement>('[data-index="49"]')!;
    let animation: Animation | undefined;
    for (let i = 0; i < 10 && !animation; i++) {
      await new Promise(requestAnimationFrame);
      animation = row.getAnimations()[0];
    }
    if (!animation) throw new Error('Expected processing-entry motion');
    animation.pause();
    const duration = Number(animation.effect!.getTiming().duration);
    const positions: number[] = [];
    for (let at = 0; at <= duration + 40; at += 40) {
      animation.currentTime = Math.min(at, duration);
      positions.push(row.getBoundingClientRect().top);
    }
    return positions;
  });
  expect(Math.abs(samples[0] - samples[samples.length - 1])).toBeGreaterThan(90);
  for (let i = 1; i < samples.length; i++) {
    expect(Math.abs(samples[i] - samples[i - 1])).toBeLessThanOrEqual(30);
    expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1);
  }
});

test('first request after opening a group does not reset its transcript when the self control arrives', async ({ page }) => {
  for (let opening = 0; opening < 2; opening++) {
    await page.goto('/tests/visual/processingTrajectory.html?count=50&cold=1');
    await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
    const step = (phase: number) => page.evaluate(phase => (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory.step(phase), phase);
    await step(1);
    await step(3);
    await expect(page.locator('.app-agent-waiting-wave')).toBeVisible();
    await page.waitForTimeout(300);
    const history = await page.locator('[data-index="49"]').elementHandle();
    const viewport = await page.locator('[data-virtual-transcript-scroll]').elementHandle();
    const ready = page.evaluate(async () => {
      const element = document.querySelector('[data-virtual-transcript-size]')!;
      let stayedReady = true;
      for (let i = 0; i < 40; i++) {
        await new Promise(requestAnimationFrame);
        stayedReady &&= element.isConnected && element.getAttribute('data-virtual-transcript-session-ready') === 'true';
      }
      return stayedReady;
    });
    await step(4); // First self-addressed processing control materializes during runtime start.
    await step(5);
    expect(await ready).toBe(true);
    expect(await history!.evaluate(element => element.isConnected)).toBe(true);
    expect(await viewport!.evaluate(element => element.isConnected)).toBe(true);
    await step(10);
    await expect(page.getByText('Synthetic final answer that fits on one line.', { exact: true })).toBeVisible();
  }
});
