import { expect, test } from '@playwright/test';

// Renders the list with the app's real stylesheet, where theme-palette.css binds the transient surface token to glass.
for (const theme of ['light', 'dark'] as const) {
  test(`pinned message list is opaque and opens without a focus ring in ${theme}`, async ({ page }) => {
    await page.goto(`/tests/visual/pinnedMessageList.html?theme=${theme}`);
    await page.getByRole('button', { name: 'View all 3 pinned messages' }).click();
    const list = page.getByRole('dialog', { name: 'Pinned messages' });
    await expect(list).toBeVisible();
    await expect(list).toBeFocused();
    const alpha = await list.evaluate((element) => {
      const probe = document.createElement('canvas').getContext('2d')!;
      probe.fillStyle = getComputedStyle(element).backgroundColor;
      probe.fillRect(0, 0, 1, 1);
      return probe.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha).toBe(255);
    const unpin = list.getByRole('button', { name: 'Unpin' }).first();
    await expect(unpin).toHaveCSS('opacity', '0');
    await list.locator('.app-pin-list-row').first().hover();
    await expect(unpin).toHaveCSS('opacity', '1');
    await expect(list.locator('.app-pin-list-meta').first()).toHaveText(/^Me·?\s*\S/);
    await expect(list).not.toContainText('Everyone');
    await expect(list).toContainText('Only you');
    await page.keyboard.press('Escape');
    await expect(list).not.toBeVisible();
  });
}
