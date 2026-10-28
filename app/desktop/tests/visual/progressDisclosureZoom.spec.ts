import { expect, test } from '@playwright/test';

for (const zoom of [1, 1.5, 2]) {
  test(`progress disclosure fits its content at ${zoom}x zoom`, async ({ page }) => {
    await page.setViewportSize({ width: 3200, height: 1800 });
    await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=9');
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
    const header = page.locator('.app-turn-worked-header');
    const disclosure = page.locator('.app-ordered-progress > .app-progress-disclosure');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const heightDifference = () => disclosure.evaluate(element => Math.abs(
      element.getBoundingClientRect().height - element.firstElementChild!.getBoundingClientRect().height,
    ));
    await expect.poll(heightDifference).toBeLessThan(1);
    // A transformed ancestor must not get included in a CSS layout height either.
    await page.locator('.app-ordered-progress').evaluate(element => { element.style.transform = 'scale(1.25)'; });
    await header.click();
    await expect.poll(() => disclosure.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(1);
    await header.click();
    await expect.poll(heightDifference).toBeLessThan(1);
    // Tool details change the content after opening; ResizeObserver must follow it.
    const tool = page.locator('.app-tool-activity-toggle').first();
    await tool.focus();
    await page.keyboard.press('Enter');
    await expect.poll(heightDifference).toBeLessThan(1);
    await expect(page.locator('.app-tool-output').first()).toBeVisible();
    await tool.focus();
    await page.keyboard.press('Enter');
    await expect.poll(heightDifference).toBeLessThan(1);
  });
}
