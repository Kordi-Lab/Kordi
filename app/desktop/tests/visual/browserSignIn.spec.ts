import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`browser sign-in welcome, wait and paste-code screens fit the login window in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto(`/tests/visual/browserSignIn.html?theme=${theme}`);
    const logIn = page.getByRole('button', { name: 'Log in', exact: true });
    await expect(logIn).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('Trouble logging in?')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(0);
    await page.screenshot({ path: `test-results/browser-sign-in-welcome-${theme}.png` });

    await logIn.click();
    await expect(page.getByText('Continue in your browser')).toBeVisible();
    await expect(page.getByText('Log in on app.example.test, then come back here.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open browser again' })).toBeInViewport({ ratio: 1 });
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
