import { expect, test, type Page } from '@playwright/test';

// The bird body must render as a solid fill, not just the wing.
async function expectBirdBody(page: Page, birdSelector: string) {
  const bird = page.locator(birdSelector);
  await expect(bird).toBeVisible();
  await expect(bird.locator('mask')).toHaveCount(0);
  const fill = await bird.locator('.app-kordi-flying-bird-fill').first().evaluate((path) => getComputedStyle(path).fill);
  expect(fill).toMatch(/^rgb\(/);
  const box = await bird.locator('.app-kordi-flying-bird-fill').first().boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`browser sign-in welcome, wait and paste-code screens fit the login window in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto(`/tests/visual/browserSignIn.html?theme=${theme}`);
    const logIn = page.getByRole('button', { name: 'Log in', exact: true });
    await expect(logIn).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('Trouble logging in?')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(0);
    await expectBirdBody(page, '.app-cloud-welcome-bird');
    await page.screenshot({ path: `test-results/browser-sign-in-welcome-${theme}.png` });

    await logIn.click();
    await expect(page.getByText('Continue in your browser')).toBeVisible();
    await expect(page.getByText(/Log in on|come back here/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open browser again' })).toBeInViewport({ ratio: 1 });
    await expectBirdBody(page, '.app-cloud-browser-signin-bird');
    await page.screenshot({ path: `test-results/browser-sign-in-waiting-${theme}.png` });

    await page.getByRole('button', { name: 'Paste code' }).click();
    const code = page.getByRole('textbox', { name: 'Paste code' });
    await expect(code).toBeFocused();
    await code.fill('kac_synthetic');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('That code expired or was already used. Log in again.');
    await expect(code).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `test-results/browser-sign-in-paste-${theme}.png` });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(logIn).toBeVisible();
  });
}
