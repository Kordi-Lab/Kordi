import { expect, test, type Locator } from '@playwright/test';

async function expectStableDuring(anchor: Locator, change: () => Promise<void>) {
  const recording = anchor.evaluate(async element => {
    const positions = [element.getBoundingClientRect().top];
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      positions.push(element.getBoundingClientRect().top);
    }
    return positions;
  });
  await change();
  const positions = await recording;
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
}

test('prepending the same sender preserves the first message body', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryBoundary.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await viewport.evaluate(element => { element.scrollTop = 60; });
  const body = page.getByText('Synthetic message 100', { exact: true });
  await expect(body).toBeVisible();
  await page.waitForTimeout(200);
  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    await expectStableDuring(body, () => page.getByRole('button', { name: 'Prepend history' }).click());
  }
});

test('older pin notices arrive with their messages without displacing visible history', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryBoundary.html?pins');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('[data-pin-activity]')).toHaveCount(0);
  const body = page.getByText('Synthetic message 100', { exact: true });
  await expect(body).toBeAttached();
  await body.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-virtual-transcript-scroll]')!;
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 160;
  });
  await expect(body).toBeVisible();
  await page.waitForTimeout(200);
  await expectStableDuring(body, () => page.getByRole('button', { name: 'Prepend history' }).click());
});

test('a partially visible row inside the pane padding stays anchored when it grows', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryBoundary.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  // Signal history-reading intent before setting the precise pane-padding boundary.
  await viewport.dispatchEvent('wheel', { deltaY: -1 });
  await viewport.evaluate(element => { element.scrollTop = 0; });
  const row = page.locator('[data-transcript-window-item][data-index="0"]');
  await expect(row).toBeVisible();
  const height = await row.evaluate(element => element.getBoundingClientRect().height);
  await viewport.evaluate((element, height) => { element.scrollTop = height + 10; }, height);
  await page.waitForTimeout(200);
  expect(await row.evaluate(element => element.getBoundingClientRect().bottom
    - element.closest('[data-virtual-transcript-scroll]')!.getBoundingClientRect().top)).toBeGreaterThan(0);
  await expectStableDuring(row, () => page.getByRole('button', { name: 'Expand first message' }).click());
});

test('leaving the tail without the wheel cancels a pending tail scroll', async ({ page }) => {
  await page.goto('/tests/visual/transcriptHistoryBoundary.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const viewport = page.locator('[data-virtual-transcript-scroll]');
  await viewport.dispatchEvent('wheel', { deltaY: -1 });
  await viewport.evaluate(element => { element.scrollTop = 0; });
  const body = page.getByText('Synthetic message 100', { exact: true });
  await expect(body).toBeVisible();
  // Return to the latest message, then leave again by keyboard or scrollbar
  // before the virtualizer has confirmed that it reached the tail.
  await page.getByRole('button', { name: 'Go to latest message' }).evaluate(async button => {
    const transcript = button.closest('[data-virtual-transcript-shell]')!
      .querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    (button as HTMLButtonElement).click();
    // Let React commit the click, but stay ahead of the next frame.
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    transcript.scrollTop = 0;
  });
  await expect(body).toBeVisible();
  // Growing a row moves the tail offset. The reader must stay in history.
  await page.getByRole('button', { name: 'Expand first message' }).click();
  const distancesFromTail = await viewport.evaluate(async element => {
    const distances: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      distances.push(element.scrollHeight - element.clientHeight - element.scrollTop);
    }
    return distances;
  });
  expect(Math.min(...distancesFromTail)).toBeGreaterThan(1000);
  await expect(page.getByText('Synthetic message 101', { exact: true })).toBeVisible();
});
