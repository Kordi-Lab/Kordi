import { expect, test, type Page } from '@playwright/test';

// Group Info (GroupDetailsDialog): the admin's inline rename, the Manage level
// with Dissolve group, and the member view without Manage. Synthetic data only.

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

function panel(page: Page) {
  return page.locator('[data-group-management-surface="popover"]');
}

for (const theme of ['light', 'dark'] as const) {
  test(`group Info for an admin: rename in place, Manage, Dissolve (${theme})`, async ({ page }, testInfo) => {
    await page.goto(`/tests/visual/groupInvitationGallery.html?theme=${theme}&mode=admin`);
    await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
    const info = panel(page);
    await expect(info.getByText('Group name', { exact: true })).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Dissolve group' })).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Leave group' })).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Video chat', exact: true })).toBeVisible();

    // Presence: an online person's name takes the accent, described for assistive tech; others stay plain.
    const maya = info.getByRole('button', { name: /^Maya Chen, / });
    await expect(maya).toHaveAttribute('aria-description', 'online');
    await expect(maya.locator('[title="Maya Chen"]')).toHaveClass(/app-contacts-presence-online/);
    await expect(info.getByRole('button', { name: /^Ethan Park, / })).not.toHaveAttribute('aria-description', 'online');
    await expect(info.getByRole('button', { name: /^Me, / })).not.toHaveAttribute('aria-description', 'online');

    await info.locator('.app-group-profile-actions').getByRole('button', { name: 'Add people' }).click();
    // Add people rows carry the Contacts presence line in place of the handle.
    const addRows = info.getByLabel('Contacts available to add');
    await expect(addRows.getByRole('button', { name: /Hana Mori/ }).getByText('online', { exact: true })).toBeVisible();
    await expect(addRows.getByRole('button', { name: /Jonah Weiss/ }).getByText('last seen 25 minutes ago')).toBeVisible();
    await settle(page);
    await info.screenshot({ path: testInfo.outputPath(`group-info-main-admin-${theme}.png`) });

    // Rename: the input takes the title's place without moving anything.
    const title = info.getByRole('button', { name: 'Rename Product Team' });
    const metaLine = info.getByText(/members · /);
    const metaTop = (await metaLine.boundingBox())!.y;
    await title.click();
    const input = info.getByRole('textbox', { name: 'Group name' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Product Team');
    const save = info.getByRole('button', { name: 'Save name' });
    await expect(save).toBeDisabled();
    expect((await metaLine.boundingBox())!.y).toBe(metaTop);
    await input.fill('');
    await expect(save).toBeDisabled();
    await input.fill('Launch crew');
    await expect(save).toBeEnabled();
    await settle(page);
    await info.screenshot({ path: testInfo.outputPath(`group-info-rename-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(info).toBeVisible();

    // Manage: a second level with Back, a title, a divider and Dissolve group.
    await info.locator('.app-group-profile-actions').getByRole('button', { name: 'Manage' }).click();
    await expect(info.getByRole('button', { name: 'Back' })).toBeFocused();
    const dissolve = info.getByRole('button', { name: 'Dissolve group' });
    await expect(dissolve).toBeVisible();
    await settle(page);
    await info.screenshot({ path: testInfo.outputPath(`group-info-manage-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(dissolve).toHaveCount(0);
    await expect(info.locator('.app-group-profile-actions').getByRole('button', { name: 'Manage' })).toBeFocused();

    await info.locator('.app-group-profile-actions').getByRole('button', { name: 'Manage' }).click();
    await info.getByRole('button', { name: 'Dissolve group' }).click();
    const confirm = page.getByRole('dialog', { name: 'Dissolve Product Team?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('Everyone loses access to this group.')).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath(`group-info-dissolve-confirm-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Dissolve group' })).toBeVisible();
    await info.getByRole('button', { name: 'Dissolve group' }).click();
    await page.getByRole('dialog', { name: 'Dissolve Product Team?' }).getByRole('button', { name: 'Dissolve', exact: true }).click();
    await expect(page.locator('body[data-dissolved="true"]')).toHaveCount(1);
  });

  test(`group Info for a member: no Manage or rename, leave from the own tile (${theme})`, async ({ page }, testInfo) => {
    await page.goto(`/tests/visual/groupInvitationGallery.html?theme=${theme}&mode=nonadmin`);
    await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
    const info = panel(page);
    await expect(info.locator('.app-group-profile-actions').getByRole('button', { name: 'Manage' })).toHaveCount(0);
    await expect(info.getByRole('button', { name: /^Rename / })).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Leave group' })).toHaveCount(0);
    await expect(info.getByRole('button', { name: 'Dissolve group' })).toHaveCount(0);
    await settle(page);
    await info.screenshot({ path: testInfo.outputPath(`group-info-main-member-${theme}.png`) });

    await info.getByRole('button', { name: 'Me, member' }).click();
    await info.getByRole('button', { name: 'Leave group' }).click();
    await expect(info.getByText('Leave this group?')).toBeVisible();
    await settle(page);
    await info.screenshot({ path: testInfo.outputPath(`group-info-member-leave-${theme}.png`) });
  });
}
