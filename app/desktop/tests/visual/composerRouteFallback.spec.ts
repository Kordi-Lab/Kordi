import { expect, test, type Page } from '@playwright/test';

const triggers = (page: Page) => page.locator('[data-composer-model-controls] > button');
const pendingSaves = (page: Page) => page.locator('[data-pending-saves]');

async function pick(page: Page, index: number, label: string) {
  await triggers(page).nth(index).click();
  await page.locator('.app-composer-model-menu-layer').getByRole('button', { name: label, exact: false }).click();
}

test('a model pick shows at once while its save is still pending', async ({ page }) => {
  await page.goto('/tests/visual/composerRouteFallback.html');
  await expect(triggers(page)).toHaveCount(3);
  await expect(triggers(page).nth(1)).toHaveText('gpt-6-sol');
  await pick(page, 1, 'gpt-5.6-sol');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '1');
  await expect(triggers(page).nth(1)).toHaveText('gpt-5.6-sol', { timeout: 200 });
  await expect(page.locator('.app-composer-model-menu-layer')).toHaveCount(0);
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(triggers(page).nth(1)).toHaveText('gpt-5.6-sol');
});

test('a failed save rolls the pick back with a notice', async ({ page }) => {
  await page.goto('/tests/visual/composerRouteFallback.html?fail');
  await pick(page, 2, 'High');
  await expect(triggers(page).nth(2)).toHaveText('High', { timeout: 200 });
  await expect(page.getByRole('alert')).toHaveText('Unable to save the model');
  await expect(triggers(page).nth(2)).toHaveText('Medium');
});

test('a removed account falls back to a signed-in account of the same provider', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/composerRouteFallback.html?removed');
  await expect(triggers(page).nth(0)).toHaveText('Account unavailable');
  await pick(page, 1, 'gpt-5.6-sol');
  await expect(triggers(page).nth(0)).toHaveText('ChatGPT • Work', { timeout: 200 });
  await expect(triggers(page).nth(1)).toHaveText('gpt-5.6-sol');
  await expect(triggers(page).nth(2)).toHaveText('Medium');
  await pick(page, 0, 'Research');
  await expect(triggers(page).nth(0)).toHaveText('Claude • Research', { timeout: 200 });
  await expect(triggers(page).nth(1)).toHaveText('claude-fable-5');
  await expect(triggers(page).nth(2)).toHaveText('High');
  for (const trigger of await triggers(page).all()) await expect(trigger).not.toHaveText(/^-?$/);
  await page.screenshot({ path: testInfo.outputPath('composer-route-fallback.png') });
});
