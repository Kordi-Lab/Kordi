import { expect, test } from '@playwright/test';

test('login fills its viewport throughout cover transitions and returns intact after failure', async ({ page }) => {
  await page.goto('/tests/visual/authTransitions.html');
  const surface = page.locator('.app-cloud-login-surface');
  const pageSurface = page.locator('.app-cloud-login-page');
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  const password = page.getByLabel('Password', { exact: true });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(submit).toBeVisible();
  await expect(pageSurface).toHaveJSProperty('clientHeight', 760);
  await expect(surface).toHaveJSProperty('clientHeight', 760);
  await expect(submit).toBeInViewport({ ratio: 1 });
  await email.fill('preview@example.test');
  await password.fill('test-only-value');
  await submit.click();
  await expect(page.getByText('Test sign-in failed.')).toBeVisible();
  await expect(page.getByText('Signing in…', { exact: true })).toHaveCount(0);
  await expect(email).toHaveValue('preview@example.test');
  await expect(password).toHaveValue('test-only-value');
  await expect(submit).toBeInViewport({ ratio: 1 });
  await expect(pageSurface).toHaveJSProperty('clientHeight', 760);
  await expect(surface).toHaveCSS('transform', 'none');
  await page.screenshot({ path: 'test-results/auth-transition-login.png' });
  await page.setViewportSize({ width: 760, height: 860 });
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(pageSurface).toHaveJSProperty('clientHeight', 860);
});

for (const theme of ['light', 'dark']) {
  test(`every animation frame keeps the login page at viewport size in ${theme} mode`, async ({ page }) => {
    await page.goto(`/tests/visual/authTransitions.html?theme=${theme}`);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const measurement = page.evaluate(async () => {
      const samples: Array<{ width: number; height: number; viewportWidth: number; viewportHeight: number }> = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          const bounds = document.querySelector('.app-cloud-login-page')!.getBoundingClientRect();
          samples.push({ width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight });
          if (performance.now() - start < 1600) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    });
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('preview@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-only');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Test sign-in failed.')).toBeVisible();
    await page.setViewportSize({ width: 760, height: 860 });
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.setViewportSize({ width: 760, height: 760 });
    const samples = await measurement;
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.filter(sample => Math.abs(sample.width - sample.viewportWidth) > 1 || Math.abs(sample.height - sample.viewportHeight) > 1)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport({ ratio: 1 });
  });
}

test('loading dots stay centered as the workspace contracts to the login window', async ({ page }) => {
  await page.goto('/tests/visual/authTransitions.html?loading=1');
  const dots = page.locator('.app-cloud-starting-dots');
  await expect(dots).toBeVisible();
  for (const size of [
    { width: 1480, height: 980 }, { width: 1200, height: 900 },
    { width: 960, height: 820 }, { width: 760, height: 760 },
  ]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const bounds = await dots.boundingBox();
      return bounds ? Math.abs(bounds.x + bounds.width / 2 - size.width / 2)
        + Math.abs(bounds.y + bounds.height / 2 - size.height / 2) : Infinity;
    }).toBeLessThan(1);
  }
  await expect(page.locator('.app-cloud-starting-screen')).toHaveText('');
});
