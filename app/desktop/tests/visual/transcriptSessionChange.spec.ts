import { expect, test } from '@playwright/test';

// Changing session and loading older pages must not move the visible messages.
// These are the two paths a reader hits constantly, and they are separate from
// continuous scrolling: entry reveals a measured tail, and prepending keeps a
// reading anchor fixed while new rows mount above it.
test('session entry and older-page prepend keep visible content still', async ({ page }) => {
  await page.goto('/tests/visual/transcriptSessionChange.html');
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();

  // Session entry: the revealed tail must not drift after it appears.
  const entryDrift = await page.evaluate(async () => {
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Session B')!.click();
    const element = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    const positions: number[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      const rows = [...element.querySelectorAll<HTMLElement>('[data-message-id]')];
      const last = rows[rows.length - 1];
      if (last) positions.push(last.getBoundingClientRect().top);
    }
    return positions;
  });
  const entryRange = Math.max(...entryDrift) - Math.min(...entryDrift);

  // Older-page prepend: the first visible message must hold its screen position.
  const prepend = await viewport.evaluate(async (element) => {
    element.scrollTop = 1500;
    for (let frame = 0; frame < 10; frame += 1) await new Promise(requestAnimationFrame);
    const viewportTop = element.getBoundingClientRect().top;
    const reference = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(row => row.getBoundingClientRect().top >= viewportTop + 1)!;
    const id = reference.dataset.messageId!;
    const positions = [reference.getBoundingClientRect().top - viewportTop];
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Load older')!.click();
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      const current = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (current) positions.push(current.getBoundingClientRect().top - viewportTop);
    }
    return { id, positions };
  });
  const prependRange = Math.max(...prepend.positions) - Math.min(...prepend.positions);

  expect(entryRange, JSON.stringify({ entryRange, entryDrift: entryDrift.slice(0, 20) })).toBeLessThanOrEqual(2);
  expect(prependRange, JSON.stringify({ prependRange, id: prepend.id, positions: prepend.positions.slice(0, 20) })).toBeLessThanOrEqual(2);
});
