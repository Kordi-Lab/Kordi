import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} quiet control gallery`, async ({ page }) => {
    await page.goto(`/tests/visual/quietControlGallery.html?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('[data-visual-ready="true"]')).toBeVisible();

    const rest = page.locator('[data-state-preview="rest"]');
    const hover = page.locator('[data-state-preview="hover"]');
    const focus = page.locator('[data-state-preview="focus"]');

    await hover.hover();
    await focus.focus();
    await page.locator('[data-provider-state="hover"]').hover();

    await expect(rest).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(rest).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(hover).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(focus).toBeFocused();
    await expect(page.locator('[data-provider-state="selected"]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('[data-provider-state="hover"]')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('[data-provider-state="selected"] .app-auth-provider-glyph')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('[data-chat-session-metadata="true"]')).toContainText('Forked from Hihi');
    await expect(page.locator('[data-icon="cloud"]')).toHaveCount(0);

    const titleContainer = page.locator('[data-rename-title-container]');
    const renameTitle = page.locator('[data-rename-title]');
    const titleContainerBox = await titleContainer.boundingBox();
    const renameTitleBox = await renameTitle.boundingBox();
    expect(titleContainerBox?.width).toBeGreaterThan(480);
    expect(renameTitleBox?.width).toBeGreaterThan(480);
    expect(renameTitleBox?.width).toBeLessThanOrEqual((titleContainerBox?.width ?? 0) + 1);
    await expect(renameTitle).toHaveCSS('text-overflow', 'ellipsis');
    expect(await renameTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    await expect(page.locator('[data-quiet-gallery]')).toHaveScreenshot(`quiet-controls-${theme}.png`);
  });
}
