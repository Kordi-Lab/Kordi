import { expect, test, type Page } from '@playwright/test';
import { installApiFixture, stubSitePages, isCancelledFixtureRequest } from './apiFixture';

const invite = `kordi_gi_${'b'.repeat(43)}`;

// Records any sign-in form the app renders itself, across navigations.
async function watchForAppSignInForm(page: Page) {
  const seen: string[] = [];
  await page.exposeFunction('reportAppSignInForm', (what: string) => { seen.push(what); });
  await page.addInitScript(() => {
    if (!location.pathname.startsWith('/app')) return;
    const report = (window as unknown as { reportAppSignInForm: (what: string) => void }).reportAppSignInForm;
    const check = () => {
      if (document.querySelector('input[type="password"]')) report('password field');
      if (document.body?.textContent?.includes('Supercollaboration')) report('old sign-in copy');
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return seen;
}

test('a signed-out page goes to the site login, then back to the same page after sign-in', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  let signedIn = false;
  await installApiFixture(page, baseURL!, () => signedIn);
  const visits = await stubSitePages(page);
  const appForms = await watchForAppSignInForm(page);
  await page.goto('/app/contacts');
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Fapp%2Fcontacts`);
  expect(visits).toEqual(['/login?next=%2Fapp%2Fcontacts']);
  expect(appForms).toEqual([]);

  // The site page signs in and returns to `next`.
  signedIn = true;
  const next = new URL(page.url()).searchParams.get('next')!;
  await page.goto(next);
  await expect(page).toHaveURL(`${baseURL}/app/contacts`);
  await expect(page.getByRole('link', { name: 'Contacts', exact: true }).first()).toBeVisible();
  expect(appForms).toEqual([]);
  expect(errors).toEqual([]);
});

test('the welcome and invitation hand-offs survive the trip to the site login', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, false);
  await stubSitePages(page);
  await page.goto('/app/?welcome=1');
  await expect(page).toHaveURL(`${baseURL}/login?next=${encodeURIComponent('/app/?welcome=1')}`);
  await page.goto(`/app/chats?groupInvite=${invite}`);
  await expect(page).toHaveURL(`${baseURL}/login?next=${encodeURIComponent(`/app/chats?groupInvite=${invite}`)}`);
  // The app keeps the invitation for after sign-in too.
  expect(await page.evaluate(() => localStorage.getItem('kordi.pendingGroupInvitation.v1'))).toBe(invite);
});

test('a failed Google or GitHub sign-in shows its error on the site login', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, false);
  await stubSitePages(page);
  await page.goto('/app/chats#kordi_cloud_oauth_error=Free%20text&kordi_cloud_oauth_error_code=access_pending');
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Fapp%2Fchats#kordi_cloud_oauth_error_code=access_pending`);
});

test('signing out lands on the site login without a return path', async ({ page, baseURL }) => {
  let signedIn = true;
  await installApiFixture(page, baseURL!, () => signedIn);
  await page.route('**/v1/cloud/auth/web/logout', route => {
    signedIn = false;
    return route.fulfill({ status: 204 });
  });
  await stubSitePages(page);
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page.getByRole('button', { name: 'Open account settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/login`);
});
