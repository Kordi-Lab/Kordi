import { expect, test } from '@playwright/test';
import { installApiFixture, stubSitePages, isCancelledFixtureRequest } from './apiFixture';

test('browser build sends a signed-out visitor to the site sign-in without a native runtime or token URL', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  await installApiFixture(page, baseURL!, false);
  await stubSitePages(page);
  const response = await page.goto('/app/chats');
  expect(await response!.text()).toContain('/app/assets/');
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Fapp%2Fchats`);
  await expect(page.getByRole('heading', { name: 'Site login', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
  expect(page.url()).not.toMatch(/[?#].*token=/);
});

test('cookie session opens the complete shell, browser history and reload', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const requests = await installApiFixture(page, baseURL!, true);
  await page.goto('/app/chats');
  for (const name of ['Contacts', 'Chats', 'Agent Chats', 'Factory', 'Digest']) {
    await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible();
  }
  await page.getByRole('link', { name: 'Contacts', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  await page.getByRole('link', { name: 'Chats', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/chats$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Contacts', exact: true }).first()).toBeVisible();
  expect(requests.filter(request => request.path === '/v1/cloud/auth/me').length).toBeGreaterThan(0);
  expect(requests.every(request => !request.headers.authorization)).toBe(true);
  expect(errors).toEqual([]);
});
