import { expect, test } from '@playwright/test';

// A chat's Memory tab: the centered empty state, and the list with the sync status and Add memory
// in one row above it.

test.use({ viewport: { width: 1100, height: 700 } });

for (const theme of ['light', 'dark'] as const) {
  test(`conversation memory tab without memories (${theme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    await page.goto(`/tests/visual/conversationMemory.html?empty=1&theme=${theme}`);
    const empty = page.locator('[data-memory-empty]');
    await expect(empty.getByText('No memories yet', { exact: true })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'Add memory' })).toBeVisible();
    await expect(page.getByText(/Synced with/)).toHaveCount(0);
    await expect(page).toHaveScreenshot(`conversationMemory-empty-${theme}.png`);
  });
}

test('conversation memory tab with memories (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/conversationMemory.html?theme=light');
  await expect(page.locator('[data-memory-lesson]')).toHaveCount(2);
  const header = page.locator('[data-memory-add]');
  await expect(header.getByText(/Synced with taylor@memory\.example/)).toBeVisible();
  await expect(header.getByRole('button', { name: 'Add memory' })).toBeVisible();
  // The status starts at the rows' text edge.
  const statusBox = await header.getByText(/Synced with/).boundingBox();
  const rowBox = await page.locator('[data-memory-lesson]').first().boundingBox();
  expect(Math.abs((statusBox?.x ?? 0) - (rowBox?.x ?? 1))).toBeLessThan(1);
  await expect(page).toHaveScreenshot('conversationMemory-list-light.png');
});
