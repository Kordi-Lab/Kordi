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

type ReplySample = Sample & { replyTop: number | null; status: string | null };

// The latest agent reply's quote, linked-session status, background tools and
// the card's subsession snapshot all arrive after the group opens. The reply
// may grow once while that happens, but it must never move back and forth, and
// the latest message must stay at the bottom.
for (const asyncDelay of [0, 150, 500, 1200]) test(`late reply parts keep the opened group settled (after ${asyncDelay}ms)`, async ({ page }) => {
  await page.route('**/v1/cloud/agent-subsessions/**', async (route) => {
    await new Promise(resolve => setTimeout(resolve, asyncDelay));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      sessionId: 'synthetic-background-13', parentSessionId: 'synthetic-group', parentRequestId: 'request-13',
      ownerAccountId: 'synthetic-account', agentId: 'synthetic-agent', ownerDisplayName: 'You',
      agentDisplayName: 'Synthetic Agent', title: 'Synthetic background task 13', status: 'failed',
      messages: [], version: 3, updatedAt: '2026-01-05T21:00:00Z', live: false, queued: false, startedAtMs: null,
    }) });
  });
  await page.addInitScript(() => {
    const samples: ReplySample[] = [];
    Object.assign(window, { replySamples: samples });
    let start = 0;
    const sample = () => {
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]');
      const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
      const rows = [...document.querySelectorAll<HTMLElement>('[data-transcript-window-item="true"]')];
      const last = rows.find(row => row.textContent?.includes('Synthetic request 99'));
      // The parent reply carries the linked background-session card.
      const reply = rows.find(row => row.querySelector('[data-related-agent-session-id="synthetic-background-13"]'));
      if (content && viewport && last && getComputedStyle(content).visibility !== 'hidden') {
        start ||= performance.now();
        samples.push({
          t: Math.round(performance.now() - start), scrollTop: Math.round(viewport.scrollTop),
          tailGap: Math.round(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
          lastTop: Math.round(last.getBoundingClientRect().top),
          replyTop: reply ? Math.round(reply.getBoundingClientRect().top) : null,
          status: reply?.querySelector('[data-related-agent-session-status]')?.textContent ?? null,
        });
      }
      if (!start || performance.now() - start < 2200) requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(sample);
  });
  await page.goto(`/tests/visual/transcriptOpenSettle.html?pinDelay=-1&replay=1&asyncDelay=${asyncDelay}`);
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await page.waitForFunction(() => ((window as unknown as { replySamples: ReplySample[] }).replySamples.at(-1)?.t ?? 0) >= 2000);
  const samples = await page.evaluate(() => (window as unknown as { replySamples: ReplySample[] }).replySamples);
  const trace = JSON.stringify(samples.filter((sample, index) => index === 0
    || sample.replyTop !== samples[index - 1]!.replyTop || sample.lastTop !== samples[index - 1]!.lastTop
    || sample.status !== samples[index - 1]!.status));
  // The late parts really arrived, including the card's snapshot status.
  expect(samples.at(-1)!.status, trace).toContain('Failed');
  expect(Math.max(...samples.map(sample => Math.abs(sample.tailGap))), trace).toBeLessThanOrEqual(2);
  const lastTops = samples.map(sample => sample.lastTop);
  expect(Math.max(...lastTops) - Math.min(...lastTops), trace).toBeLessThanOrEqual(2);
  const replyTops = samples.map(sample => sample.replyTop).filter((top): top is number => top !== null);
  let reversal = 0;
  let direction = 0;
  for (let index = 1; index < replyTops.length; index += 1) {
    const delta = replyTops[index]! - replyTops[index - 1]!;
    if (Math.abs(delta) <= 1) continue;
    if (direction && Math.sign(delta) !== direction) reversal = Math.max(reversal, Math.abs(delta));
    direction = Math.sign(delta);
  }
  expect(reversal, trace).toBeLessThanOrEqual(2);
});
