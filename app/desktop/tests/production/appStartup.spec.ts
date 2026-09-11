import { expect, test } from '@playwright/test';

test('the complete production bundle renders its login screen without module initialization errors', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === baseURL ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const response = await page.goto('/');
  const html = await response!.text();
  expect(html).toContain('/assets/');
  expect(html).not.toContain('/@vite/client');
  expect(html).not.toContain('/src/main.jsx');
  await expect(page.getByRole('heading', { name: 'Welcome to Kordi' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});
