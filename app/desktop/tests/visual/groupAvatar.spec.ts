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
  await page.getByRole('button', { name: 'Edit group avatar' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: 'Upload photo' }).click(),
  ]);
  await chooser.setFiles({ name: 'group.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') });
  await expect(group.locator(':scope > img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit group avatar' }).click();
  await page.getByRole('menuitem', { name: 'Remove image' }).click();
  await expect(group.locator(':scope > img')).toHaveCount(0);
  await expect(group.locator('.grid > span')).toHaveCount(9);
});

test('native photo selection reaches image preparation through the desktop bridge', async ({ page }) => {
  const bytes = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')];
  await page.addInitScript((imageBytes) => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      invoke: async (command: string) => {
        if (command !== 'desktop_pick_avatar_image') throw new Error('Unexpected native command');
        return { name: 'group.png', contentType: 'image/png', bytes: imageBytes };
      },
    } });
  }, bytes);
  await page.goto('/tests/visual/groupAvatarGallery.html', { waitUntil: 'domcontentloaded' });
  const avatar = page.getByRole('img', { name: 'Research group avatar' }).first();
  await expect(avatar.locator('.grid > span')).toHaveCount(9);
  await page.getByRole('button', { name: 'Edit group avatar' }).click();
  await page.getByRole('menuitem', { name: 'Upload photo' }).click();
  await expect(avatar.locator(':scope > img')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
