import { expect, test } from '@playwright/test';

test('media lightbox remains image-first across desktop sizes and themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=dark&index=0');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();

  const lightbox = page.getByRole('dialog', { name: 'Image preview: Quiet signal landscape.png' });
  const image = lightbox.locator('img');
  const next = page.getByRole('button', { name: 'Next image' });
  await expect(lightbox).toBeVisible();
  await expect(next).toHaveCSS('opacity', '0');
  const wideBox = await image.boundingBox();
  expect(wideBox).not.toBeNull();
  expect(wideBox!.x).toBeGreaterThanOrEqual(100);
  expect(wideBox!.y).toBeGreaterThanOrEqual(60);
  await expect(page).toHaveScreenshot('media-lightbox-wide-dark.png');

  await next.hover();
  await expect(next).toHaveCSS('opacity', '1');
  await expect(page).toHaveScreenshot('media-lightbox-wide-dark-navigation.png');

  await page.setViewportSize({ width: 720, height: 560 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=light&index=1');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
  const compactImage = page.getByRole('dialog', { name: 'Image preview: Quiet signal portrait.png' }).locator('img');
  const compactBox = await compactImage.boundingBox();
  expect(compactBox).not.toBeNull();
  expect(compactBox!.x).toBeGreaterThanOrEqual(50);
  expect(compactBox!.y).toBeGreaterThanOrEqual(40);
  expect(compactBox!.x + compactBox!.width).toBeLessThanOrEqual(670);
  expect(compactBox!.y + compactBox!.height).toBeLessThanOrEqual(536);
  await expect(page).toHaveScreenshot('media-lightbox-compact-light.png');
});
