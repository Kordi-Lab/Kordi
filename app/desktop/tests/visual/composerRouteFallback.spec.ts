import { expect, test, type Page } from '@playwright/test';

const modelButton = (page: Page) => page.getByRole('button', { name: /^Select model, current / });
const effortButton = (page: Page) => page.getByRole('button', { name: /^Adjust effort, current / });
const picker = (page: Page) => page.locator('.app-model-picker');
const pendingSaves = (page: Page) => page.locator('[data-pending-saves]');

async function pickModel(page: Page, name: string) {
  await modelButton(page).click();
  await page.getByRole('dialog', { name: 'Select model' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

// A different account asks once before the shared route changes.
async function chooseAccount(page: Page, name: string) {
  await page.getByRole('dialog', { name: 'Choose account' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name: 'Change shared account' }).getByRole('button', { name: 'Change account' }).click();
}

test('a model pick shows at once while its save is still pending', async ({ page }) => {
  await page.goto('/tests/visual/composerRouteFallback.html');
  await expect(page.locator('.app-model-effort-pill > button')).toHaveCount(2);
  await expect(modelButton(page)).toHaveText('6 Sol');
  await pickModel(page, 'GPT-5.6 Sol');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '1');
  await expect(modelButton(page)).toHaveText('5.6 Sol', { timeout: 200 });
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(picker(page)).toHaveCount(0);
  await expect(modelButton(page)).toHaveText('5.6 Sol');
});

test('a failed save rolls the pick back with a notice', async ({ page }) => {
  await page.goto('/tests/visual/composerRouteFallback.html?fail');
  await pickModel(page, 'GPT-5.6 Sol');
  await expect(modelButton(page)).toHaveText('5.6 Sol', { timeout: 200 });
  await expect(pendingSaves(page).getByRole('alert')).toHaveText('Unable to save the model');
  await expect(modelButton(page)).toHaveText('6 Sol');
  // The picker stays open with the failure and a way to try again.
  const menu = page.getByRole('dialog', { name: 'Select model' });
  await expect(menu.getByRole('alert')).toBeVisible();
  await menu.getByRole('button', { name: 'Retry' }).click();
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '1');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(modelButton(page)).toHaveText('6 Sol');

  await page.keyboard.press('Escape');
  await effortButton(page).click();
  const slider = page.getByRole('dialog', { name: 'Thinking effort' }).getByRole('slider', { name: 'Thinking effort' });
  await slider.focus(); await slider.press('ArrowRight');
  await expect(effortButton(page)).toHaveText('High', { timeout: 200 });
  await expect(pendingSaves(page).getByRole('alert')).toHaveText('Unable to save the model');
  await expect(effortButton(page)).toHaveText('Medium');
});

test('a removed account asks for a signed-in account before a pick saves', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/composerRouteFallback.html?removed');
  await expect(modelButton(page)).toHaveText('Account unavailable');
  await expect(modelButton(page)).toHaveAccessibleName('Select model, current GPT-6 Sol, Account unavailable');
  await pickModel(page, 'GPT-5.6 Sol');
  // Only accounts of the picked model's provider are offered.
  const accounts = page.getByRole('dialog', { name: 'Choose account' });
  await expect(accounts.getByRole('status')).toContainText('Account unavailable');
  await expect(accounts.getByRole('button', { name: 'Claude • Research' })).toHaveCount(0);
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await chooseAccount(page, 'ChatGPT • Work');
  await expect(modelButton(page)).toHaveText('5.6 Sol', { timeout: 200 });
  await expect(effortButton(page)).toHaveText('Medium');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(picker(page)).toHaveCount(0);

  // A model of another provider switches to that provider's account.
  await pickModel(page, 'Claude Fable 5');
  await chooseAccount(page, 'Claude • Research');
  await expect(modelButton(page)).toHaveText('Claude Fable 5', { timeout: 200 });
  await expect(effortButton(page)).toHaveText('High');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await modelButton(page).click();
  await expect(page.locator('.app-model-picker-account')).toHaveText('Claude • Research');
  await page.keyboard.press('Escape');
  for (const trigger of await page.locator('.app-model-effort-pill > button').all()) await expect(trigger).not.toHaveText(/^-?$/);
  await page.screenshot({ path: testInfo.outputPath('composer-route-fallback.png') });
});

test('once the account lists load, an unavailable account stays until the owner picks one', async ({ page }) => {
  await page.goto('/tests/visual/composerRouteFallback.html?removed&loaded');
  await expect(modelButton(page)).toHaveText('Account unavailable');
  await page.waitForTimeout(500);
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(modelButton(page)).toHaveText('Account unavailable');
  await modelButton(page).click();
  await page.getByRole('dialog', { name: 'Select model' }).getByRole('button', { name: 'Account unavailable' }).first().click();
  await chooseAccount(page, 'ChatGPT • Work');
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '1');
  await expect(modelButton(page)).toHaveText('6 Sol', { timeout: 200 });
  await expect(pendingSaves(page)).toHaveAttribute('data-pending-saves', '0');
  await expect(modelButton(page)).toHaveAccessibleName('Select model, current GPT-6 Sol');
  await expect(effortButton(page)).toHaveText('Medium');
});
