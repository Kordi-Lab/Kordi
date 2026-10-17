import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

type Sample = { t: number; scrollTop: number; tailGap: number; lastTop: number };

// Opening a group must paint its latest message once and keep it there while
// pins, the pin notice, and folded agent answers finish arriving.
for (const pinDelay of [-1, 120, 400, 800]) test(`opening a group settles at the latest message (pins ${pinDelay < 0 ? 'cached' : `after ${pinDelay}ms`})`, async ({ page }) => {
  await page.addInitScript(() => {
    const samples: Sample[] = [];
    Object.assign(window, { openSamples: samples });
    // Time is measured from the first visible paint of the transcript.
    let start = 0;
    const sample = () => {
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]');
      const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
      const last = [...document.querySelectorAll<HTMLElement>('[data-transcript-window-item="true"]')]
        .find(row => row.textContent?.includes('Synthetic request 99'));
      if (content && viewport && last && getComputedStyle(content).visibility !== 'hidden') {
        start ||= performance.now();
        samples.push({
          t: Math.round(performance.now() - start), scrollTop: Math.round(viewport.scrollTop),
          tailGap: Math.round(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
          lastTop: Math.round(last.getBoundingClientRect().top),
        });
      }
      // Read after each frame paints, so resize observers have already run.
      if (!start || performance.now() - start < 1600) requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(sample);
  });
  await page.goto(`/tests/visual/transcriptOpenSettle.html?pinDelay=${pinDelay}`);
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  // The fixture renders with the app stylesheet: folded answers and the shelf use real tokens.
  await expect(page.getByText(/Show \d+ more lines/).first()).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.app-pin-shelf')!).getPropertyValue('--app-motion-base').trim())).not.toBe('');
  await expect(page.locator('.app-pin-shelf[data-open="true"]')).toHaveCount(1);
  await page.waitForFunction(() => ((window as unknown as { openSamples: Sample[] }).openSamples.at(-1)?.t ?? 0) >= 1500);
  const samples = await page.evaluate(() => (window as unknown as { openSamples: Sample[] }).openSamples);
  const trace = JSON.stringify(samples.filter((sample, index) => index === 0
    || sample.scrollTop !== samples[index - 1]!.scrollTop || sample.lastTop !== samples[index - 1]!.lastTop));
  expect(samples.length, trace).toBeGreaterThan(20);
  expect(Math.max(...samples.map(sample => Math.abs(sample.tailGap))), trace).toBeLessThanOrEqual(2);
  const tops = samples.map(sample => sample.lastTop);
  expect(Math.max(...tops) - Math.min(...tops), trace).toBeLessThanOrEqual(2);
});
