import { expect, test } from '@playwright/test';

test('history prepend and delayed media preserve the body reading point in a real browser', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistory.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 40; });
  const anchor = page.locator('[data-message-id="100"]');
  await expect(anchor).toBeVisible();
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Load older synthetic history' }).click();
  // Continue the gesture while the page is in flight.
  await viewport.evaluate(element => { element.scrollTop = 48; });
  await expect.poll(async () => page.locator('[data-message-id="99"]').count()).toBe(1);
  await expect.poll(async () => Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - (before - 8))).toBeLessThan(1);
  await page.getByRole('button', { name: 'Finish delayed media' }).click();
  await expect.poll(async () => Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - (before - 8))).toBeLessThan(1);
  // A second page must preserve the same body offset without another badge adjustment.
  await page.getByRole('button', { name: 'Load older synthetic history' }).click();
  await expect.poll(async () => Number(await viewport.evaluate(element => element.scrollTop))).toBeGreaterThan(6500);
  await expect.poll(async () => Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - (before - 8))).toBeLessThan(1);
});
