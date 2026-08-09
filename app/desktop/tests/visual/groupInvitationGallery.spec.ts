import { expect, test } from '@playwright/test';

const token = `kordi_gi_${'a'.repeat(43)}`;

test('group invitation admin and recipient previews', async ({ page }, testInfo) => {
  await page.route(`**/v1/cloud/invitations/groups/resolve/${token}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        inviter: {
          displayName: 'Jiaxin Pei',
          kordiId: '482731906',
          avatarUrl: null,
        },
        group: { name: 'Product Team', memberCount: 3 },
        expiresAt: '2026-08-15T00:00:00Z',
      }),
    });
  });

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=admin');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('tab', { name: 'Share link' }).click();
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  await expect(page.getByLabel('Group invitation link')).toHaveValue(`https://kordi.ai/g/${token}`);
  await page.screenshot({ path: testInfo.outputPath('group-invitation-admin-desktop.png') });

  await page.setViewportSize({ width: 430, height: 820 });
  await page.screenshot({ path: testInfo.outputPath('group-invitation-admin-narrow.png') });

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=nonadmin');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('tab', { name: 'Share link' }).click();
  await expect(page.getByText('Only group admins can create invitation links')).toBeVisible();
  await expect(page.getByText('Ask Jiaxin Pei to share a link or make you an admin.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invitation link' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('group-invitation-nonadmin-narrow.png') });

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=recipient');
  await expect(page.getByRole('button', { name: 'Join group' })).toBeVisible();
  await expect(page.getByText('will not add this person', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('group-invitation-recipient-narrow.png') });

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=dark&mode=recipient');
  await expect(page.getByRole('button', { name: 'Join group' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('group-invitation-recipient-dark.png') });
});
