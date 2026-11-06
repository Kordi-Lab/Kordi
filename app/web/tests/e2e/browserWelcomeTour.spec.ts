import { expect, test, type Page } from '@playwright/test';
import { installApiFixture, isCancelledFixtureRequest } from './apiFixture';

const welcome = (page: Page) => page.getByRole('complementary', { name: 'Welcome to Kordi', exact: true });
const tourCard = (page: Page) => page.locator('.help-tour-card[data-positioned="true"]');

for (const width of [1440, 390]) {
  test(`a new web account gets the welcome prompt once and a browser tour at ${width}px`, async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await installApiFixture(page, baseURL!, true);
    await page.goto('/app/?welcome=1');
    await expect(welcome(page)).toBeVisible();
    await expect(page).not.toHaveURL(/welcome=/);
    await expect(welcome(page)).toBeInViewport({ ratio: 1 });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`welcome-${width}.png`) });

    await welcome(page).getByRole('button', { name: 'Explore Kordi', exact: true }).click();
    const titles: string[] = [];
    for (;;) {
      await expect(tourCard(page)).toBeVisible({ timeout: 10_000 });
      await expect(tourCard(page)).toBeInViewport({ ratio: 1 });
      const title = (await tourCard(page).getByRole('heading').textContent()) ?? '';
      titles.push(title);
      if (titles.length <= 2) await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`tour-step-${titles.length}-${width}.png`) });
      const finish = tourCard(page).getByRole('button', { name: 'Finish tour', exact: true });
      if (await finish.isVisible()) {
        await expect(tourCard(page)).toContainText('in this browser');
        await expect(tourCard(page)).not.toContainText('calendar');
        await finish.click();
        break;
      }
      await tourCard(page).getByRole('button', { name: 'Next', exact: true }).click();
      await expect(tourCard(page).getByRole('heading')).not.toHaveText(title, { timeout: 10_000 });
    }
    // The fixture has no Grounding capability, and file import is desktop-only.
    expect(titles).toEqual([
      'Connect an AI account', 'Add someone to your contacts', 'Start a conversation',
      'Set up an agent', 'Check your daily overview', 'Find help here anytime',
    ]);
    await expect(page.locator('.help-tour-card')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Chats', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Help & setup', exact: true })).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('a returning web sign-in opens the app without first-run help', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  await page.goto('/app/');
  await expect(page.getByRole('button', { name: 'Help & setup', exact: true })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(welcome(page)).toHaveCount(0);
});

test('the welcome prompt waits until a pending group invitation is answered', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  let dismissed = false;
  await page.route('**/v1/cloud/invitations/groups/pending**', async route => {
    if (route.request().method() === 'DELETE') { dismissed = true; return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: { invitations: dismissed ? [] : [{ id: 'p_fixture', invitationId: 'inv_fixture',
      groupName: 'Reading group', inviterName: 'Maya Chen', memberCount: 3, expiresAt: '2099-01-01T00:00:00Z' }] } });
  });
  await page.goto('/app/?welcome=1');
  const invitation = page.getByRole('dialog', { name: 'Join Reading group?' });
  await expect(invitation).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(welcome(page)).toHaveCount(0);
  await invitation.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(invitation).toHaveCount(0);
  await expect(welcome(page)).toBeVisible();
});
