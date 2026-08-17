import { expect, test } from '@playwright/test';

const token = `kordi_gi_${'a'.repeat(43)}`;

test('group invitation admin and recipient previews', async ({ page }, testInfo) => {
  await page.route(`**/v1/cloud/invitations/groups/resolve/${token}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        inviter: {
          displayName: 'Maya Chen',
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
  await expect(page.getByRole('button', { name: 'Video chat', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('group-management-members-desktop.png') });
  await page.locator('.app-group-profile-actions').getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('tab', { name: 'Share link' }).click();
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  await expect(page.getByLabel('Group invitation link')).toHaveValue(`https://kordi.ai/g/${token}`);
  await page.screenshot({ path: testInfo.outputPath('group-invitation-admin-desktop.png') });

  await page.setViewportSize({ width: 430, height: 820 });
  await page.screenshot({ path: testInfo.outputPath('group-invitation-admin-narrow.png') });

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=active');
  await page.locator('.app-group-profile-actions').getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('tab', { name: 'Share link' }).click();
  await expect(page.getByRole('button', { name: 'Create new share link' })).toBeVisible();
  await expect(page.getByText('Revoke it before creating another link')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('group-invitation-active-narrow.png') });
  await page.getByRole('button', { name: 'Create new share link' }).click();
  await expect(page.getByLabel('Group invitation link')).toHaveValue(`https://kordi.ai/g/${token}`);

  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=nonadmin');
  await page.locator('.app-group-profile-actions').getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('tab', { name: 'Share link' }).click();
  await expect(page.getByText('Only group admins can create invitation links')).toBeVisible();
  await expect(page.getByText('Ask Maya Chen to share a link or make you an admin.')).toBeVisible();
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

test('contact info sheet preview', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/groupInvitationGallery.html?theme=light&mode=contact');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
  const profile = page.locator('[data-contact-profile-surface="true"]');
  await expect(profile).toBeVisible();
  await expect(profile.getByText('Maya Chen')).toBeVisible();
  await expect(profile.getByRole('button', { name: 'Message' })).toBeVisible();
  await expect(profile.getByRole('button', { name: 'Call', exact: true })).toBeVisible();
  await expect(profile.getByRole('button', { name: 'Video', exact: true })).toBeVisible();
  await expect(profile.getByRole('button', { name: 'Copy ID' })).toBeVisible();
  await expect(profile.getByText('2 photos')).toBeVisible();
  await expect(profile.getByText('1 video')).toBeVisible();
  await expect(profile.getByText('1 file')).toBeVisible();
  await expect(profile.getByText('2 groups in common')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('contact-info-sheet-desktop.png') });

  await page.setViewportSize({ width: 430, height: 760 });
  await expect(profile).toBeVisible();
  const isContained = await profile.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth
      && rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(isContained).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('contact-info-sheet-narrow.png') });
});
