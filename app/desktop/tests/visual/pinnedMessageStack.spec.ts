import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`pin strip cycles and centers its keyboard-accessible list at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/tests/visual/pinned-stack-preview.html');
    const strip = page.locator('[data-pinned-message-bar]');
    await expect(strip).toHaveAttribute('data-pinned-message-count', '3');
    await page.getByRole('button', { name: 'Next pinned message, 1 of 3' }).click();
    await expect(strip).toHaveAttribute('data-pinned-message-index', '1');
    await expect(strip.locator('.app-pin-stack-preview')).toContainText('Preview link:');
    await page.getByRole('button', { name: 'View all 3 pinned messages' }).click();
    const list = page.getByRole('dialog', { name: 'Pinned messages' });
    await expect(list).toBeVisible();
    await expect(list).not.toContainText('of 5 pins');
    const bounds = await list.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport.height / 2)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(list).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'View all 3 pinned messages' })).toBeFocused();
    await page.keyboard.press('Enter');
    await list.getByRole('button', { name: /Release checklist:/ }).first().click();
    await expect(list).not.toBeVisible();
    await expect(strip).toHaveAttribute('data-pinned-message-index', '2');
    await page.getByRole('button', { name: 'Next pinned message, 3 of 3' }).click();
    await expect(strip).toHaveAttribute('data-pinned-message-index', '0');
    await expect(page.locator('.message-column > button')).toHaveCount(0);
    await expect(page.getByText('Message pinned', { exact: true })).toHaveCount(0);
  });
}
