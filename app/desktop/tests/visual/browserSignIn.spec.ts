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

// Opening the window focuses the first button without a key press. That
// focus shows nothing; Tab shows the neutral focus fill, never a ring.
for (const theme of ['light', 'dark'] as const) {
  test(`the welcome window shows focus only for keyboard navigation in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto(`/tests/visual/browserSignIn.html?theme=${theme}`);
    const logIn = page.getByRole('button', { name: 'Log in', exact: true });
    await expect(logIn).toBeVisible();
    const ring = async (button: typeof logIn) => {
      // The fill transitions in and out; read the settled state.
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
      return button.evaluate((element) => {
        const style = getComputedStyle(element);
        return { visible: element.matches(':focus-visible'), style: style.outlineStyle, fill: /inset/.test(style.boxShadow) };
      });
    };

    await logIn.evaluate((element) => (element as HTMLElement).focus());
    const opened = await ring(logIn);
    expect(opened.visible, 'the browser would draw a ring for this focus').toBe(true);
    expect(opened.style).toBe('none');
    expect(opened.fill).toBe(false);

    // WebKit only tabs to buttons when the system setting allows it, so move
    // focus directly after the key press.
    await page.keyboard.press('Tab');
    const signUp = page.getByRole('button', { name: 'Sign up', exact: true });
    await signUp.evaluate((element) => (element as HTMLElement).focus());
    const tabbed = await ring(signUp);
    expect(tabbed.style).toBe('none');
    expect(tabbed.fill, 'keyboard focus shows the fill').toBe(true);

    await page.mouse.click(5, 5);
    await signUp.evaluate((element) => (element as HTMLElement).focus());
    expect((await ring(signUp)).fill, 'a click ends keyboard navigation').toBe(false);
  });
}
