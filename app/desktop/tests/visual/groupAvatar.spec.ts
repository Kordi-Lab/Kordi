import { expect, test } from '@playwright/test';

test('group image selection and removal restore the square member collage', async ({ page }) => {
  await page.goto('/tests/visual/groupAvatarGallery.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('img', { name: 'Research group avatar' }).first()).toBeVisible();
  const group = page.getByRole('img', { name: 'Research group avatar' }).first();
  const mask = await group.evaluate(element => ({ radius: getComputedStyle(element).borderRadius, width: element.clientWidth, height: element.clientHeight }));
  expect(mask.radius).toBe('17%');
  expect(mask.width).toBe(mask.height);
  await expect(group.locator('.grid > span')).toHaveCount(9);
  const rowAvatar = page.getByRole('img', { name: 'Research group avatar' }).last();
  const tile = rowAvatar.locator('.grid > span').first();
  const bounds = await tile.evaluate(element => {
    const outer = element.getBoundingClientRect();
    const inner = element.firstElementChild!.getBoundingClientRect();
    return { top: inner.top - outer.top, width: inner.width, height: inner.height };
  });
  expect(bounds.top).toBe(0);
  expect(bounds.width).toBe(bounds.height);
  // A small synthetic PNG exercises the existing crop/upload preparation path.
  await page.getByLabel('Group image file').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') });
  await expect(page.getByRole('button', { name: 'Remove image' })).toBeVisible();
  await expect(group.locator(':scope > img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove image' }).click();
  await expect(group.locator(':scope > img')).toHaveCount(0);
  await expect(group.locator('.grid > span')).toHaveCount(9);
});
