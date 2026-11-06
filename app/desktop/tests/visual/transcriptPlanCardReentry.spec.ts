import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

test.use({ reducedMotion: 'no-preference' });

type Sample = { t: number; visible: boolean; card: { top: number; height: number } | null; tailTop: number | null };

async function recordEntry(page: Page, button: string): Promise<Sample[]> {
  return page.evaluate(async (name) => {
    const samples: Sample[] = [];
    const start = performance.now();
    const sample = () => {
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]');
      const card = document.querySelector<HTMLElement>('section.app-plan-card');
      const rect = card?.getBoundingClientRect();
      samples.push({
        t: Math.round(performance.now() - start),
        visible: Boolean(content && getComputedStyle(content).visibility !== 'hidden'),
        card: rect ? { top: Math.round(rect.top), height: Math.round(rect.height) } : null,
        tailTop: null,
      });
    };
    [...document.querySelectorAll('button')].find(element => element.textContent === name)!.click();
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise(requestAnimationFrame);
      sample();
    }
    return samples;
  }, button);
}

function visibleCardBoxes(samples: Sample[]) {
  return [...new Set(samples.filter(sample => sample.visible && sample.card).map(sample => JSON.stringify(sample.card)))];
}

test('the System plan card does not move when a chat opens, and a reopened chat shows at once', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/transcriptPlanCardReentry.html');
  await expect(page.locator('section.app-plan-card').getByRole('button', { name: "I'm in" })).toBeVisible();
  const entries: Record<string, Sample[]> = {};
  // First visits: history may stay hidden while it measures, but once visible the card stays put.
  entries.firstSecond = await recordEntry(page, 'Open second chat');
  // Return visits, both from another chat and from another page (the transcript re-mounts).
  entries.returnFirst = await recordEntry(page, 'Open first chat');
  entries.leave = await recordEntry(page, 'Leave chats');
  entries.remountFirst = await recordEntry(page, 'Open first chat');
  entries.returnSecond = await recordEntry(page, 'Open second chat');
  const out = process.env.KORDI_FRAME_LOG;
  if (out) fs.writeFileSync(out, JSON.stringify(entries, null, 1));
  for (const [name, samples] of Object.entries(entries)) {
    if (name === 'leave') continue;
    expect(visibleCardBoxes(samples), `${name}: plan card box once visible`).toHaveLength(1);
    expect(samples.at(-1)?.card?.height, `${name}: answer buttons render`).toBeGreaterThan(100);
  }
  for (const name of ['returnFirst', 'remountFirst', 'returnSecond']) {
    // A chat the reader has seen paints its history in the first frame after opening.
    expect(entries[name][0].visible, `${name}: no hidden frame on return`).toBe(true);
  }
  testInfo.annotations.push({ type: 'frames', description: JSON.stringify(Object.fromEntries(Object.entries(entries).map(([name, samples]) => [name, samples.findIndex(sample => sample.visible)]))) });
});
