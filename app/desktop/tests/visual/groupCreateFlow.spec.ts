import { expect, test, type Page } from '@playwright/test';

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

const preview = '/tests/visual/groupCreateFlow.html';

for (const theme of ['light', 'dark'] as const) {
  test(`a new group opens with a centered "created the group" line (${theme})`, async ({ page }) => {
    await page.goto(`${preview}?theme=${theme}&mode=transcript`);
    const created = page.getByText('Ava Lee created the group', { exact: true });
    await expect(created).toBeVisible();
    const row = page.locator('.app-system-notice-row').filter({ hasText: 'Ava Lee created the group' });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveCSS('justify-content', 'center');
    await page.screenshot({ path: test.info().outputPath(`group-created-line-${theme}.png`) });
  });

  test(`group admins dissolve a channel from its menu (${theme})`, async ({ page }) => {
    await page.goto(`${preview}?theme=${theme}&mode=channel`);
    const dissolve = page.getByRole('button', { name: 'Dissolve channel', exact: true });
    await expect(dissolve).toBeVisible();
    await settle(page);
    await page.screenshot({ path: test.info().outputPath(`channel-menu-dissolve-${theme}.png`) });
    await dissolve.click();
    const confirm = page.getByRole('dialog', { name: 'Dissolve QA?' });
    await expect(confirm.getByText('Everyone loses access to this channel.')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: test.info().outputPath(`channel-dissolve-confirm-${theme}.png`) });
    await confirm.getByRole('button', { name: 'Dissolve', exact: true }).click();
    await expect(page.getByTestId('done')).toHaveText('dissolved:session:group:launch:session:group:qa');
    await expect(confirm).toHaveCount(0);
  });
}
