import { expect, test } from '@playwright/test';

test('earlier tool replies stay mounted throughout a follow-up generation', async ({ page }) => {
  await page.goto('/tests/visual/agentFollowupContinuity.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const previous = page.locator('[data-message-id="old-answer"]');
  await expect(previous).toBeVisible();
  await page.evaluate(() => {
    const samples: boolean[] = [];
    const original = document.querySelector('[data-message-id="old-answer"]');
    Object.assign(window, { followupSamples: samples });
    const sample = () => {
      samples.push(original?.isConnected === true);
      if (samples.length < 240) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const label of ['Start follow-up', 'Next tool', 'Finish reply']) {
    await page.getByRole('button', { name: label }).click();
    await page.evaluate(async () => {
      for (let frame = 0; frame < 15; frame += 1) await new Promise(requestAnimationFrame);
    });
    await expect(previous).toBeVisible();
  }
  const samples = await page.evaluate(() => (window as unknown as { followupSamples: boolean[] }).followupSamples);
  expect(samples.length).toBeGreaterThan(30);
  expect(samples.every(Boolean)).toBe(true);
  await expect(page.getByText('Synthetic finished reply')).toBeVisible();
});
