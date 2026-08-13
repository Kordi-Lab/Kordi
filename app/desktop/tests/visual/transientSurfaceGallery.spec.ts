import { expect, test } from '@playwright/test';

const requiredSurfaces = [
  'start-chat',
  'composer-menu',
  'context-menu',
  'attachment-actions',
  'contact-card',
  'confirmation',
  'authentication',
  'updater',
  'group-management',
  'detached-auxiliary',
];

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} transient surface gallery`, async ({ page }) => {
    await page.goto(`/tests/visual/transientSurfaceGallery.html?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('[data-visual-ready="true"]')).toBeVisible();

    for (const surface of requiredSurfaces) {
      await expect(page.locator(`[data-visual-surface="${surface}"]`)).toBeVisible();
    }

    const identityCard = page.locator('[data-visual-surface="contact-card"] .visual-contact-card');
    await expect(identityCard.getByText('Taylor Brooks')).toBeVisible();
    await expect(identityCard.getByText('@example-user')).toBeVisible();
    await expect(identityCard.getByText('Group participant')).toHaveCount(0);
    const contactActionIsContained = await identityCard.evaluate((element) => {
      const action = element.querySelector<HTMLElement>('.visual-contact-action');
      if (!action) return false;
      return action.getBoundingClientRect().right <= element.getBoundingClientRect().right;
    });
    expect(contactActionIsContained).toBe(true);

    await expect(page.locator('[data-visual-gallery]')).toHaveScreenshot(`transient-surfaces-${theme}.png`);
  });
}

test('compact transient actions stay contained at 200% text scale', async ({ page }) => {
  await page.goto('/tests/visual/transientSurfaceGallery.html?theme=light');
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '200%';
    await document.fonts.ready;
  });

  const attachmentMenu = page.locator('[data-visual-surface="attachment-actions"] .visual-attachment-menu');
  const longAction = page.locator('[data-visual-long-action]');
  await expect(attachmentMenu).toBeVisible();
  await expect(longAction).toBeVisible();
  await expect(longAction).toHaveCSS('font-size', '20px');

  const hasHorizontalOverflow = await attachmentMenu.evaluate((element) => element.scrollWidth > element.clientWidth);
  const actionHasHorizontalOverflow = await longAction.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
  expect(actionHasHorizontalOverflow).toBe(false);
});
