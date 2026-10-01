import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`${theme}: search, assign, detach and preserve composer text`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 620 });
    await page.goto(`/tests/visual/chatProjectPicker.html?theme=${theme}`);
    await page.getByRole('textbox', { name: 'Message' }).fill('Keep this draft');
    await page.getByRole('button', { name: 'Choose project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose project' });
    await expect(page.getByRole('textbox', { name: 'Search projects' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`picker-${theme}.png`) });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.getByRole('textbox', { name: 'Search projects' }).fill('KOR');
    await expect(dialog.getByRole('button', { name: 'Design research' })).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('button', { name: 'kordi', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Project: kordi' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
    await page.getByRole('button', { name: 'Project: kordi' }).click();
    await dialog.getByRole('button', { name: 'No project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible();
  });
}

test('create inline, recover from errors and dismiss with keyboard or outside click', async ({ page }) => {
  await page.goto('/tests/visual/chatProjectPicker.html');
  const trigger = page.getByRole('button', { name: 'Choose project', exact: true });
  await trigger.click();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByLabel('Project name').fill('Notes');
  await page.getByLabel('Existing folder').fill('missing');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Project folder does not exist');
  await page.getByLabel('Existing folder').fill('');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const selected = page.getByRole('button', { name: 'Project: Notes' });
  await expect(selected).toBeVisible();
  await selected.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(selected).toBeFocused();
  await selected.click();
  await page.getByRole('button', { name: 'Outside action' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
