import { expect, test } from '@playwright/test';

test('Personal agent section, session header, source chips and menu', async ({ page }) => {
  await page.goto('/tests/visual/personalAgentPreview.html');
  const rows = page.locator('[data-testid="personal-agent-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Alex's Kordi");
  await expect(rows.nth(2)).toContainText('No messages yet');
  await expect(page.getByRole('button', { name: 'Personal agent' })).toBeVisible();
  const personalTop = (await page.getByRole('button', { name: 'Personal agent' }).boundingBox())!.y;
  const recentsTop = (await page.getByRole('button', { name: 'Recents' }).boundingBox())!.y;
  expect(personalTop).toBeLessThan(recentsTop);

  const header = page.locator('[data-personal-agent-header]');
  await expect(header).toContainText("Alex's Kordi");
  await expect(header).toContainText('Online');
  const chips = page.getByRole('list', { name: 'Sources' }).last().getByRole('listitem');
  await expect(chips).toHaveText([/^Calendar\s*Lab sync$/, /^GitHub\s*#412 review requested$/]);

  await rows.nth(1).click({ button: 'right' });
  await expect(page.locator('[data-session-context-action]')).toHaveText(['Mark as read', 'Mute', 'Agent settings']);
  await page.locator('[data-session-context-action="agent-settings"]').click();
  await expect(page.getByRole('status')).toContainText('Research agent');

  await rows.nth(2).click();
  await expect(page.locator('[data-personal-agent-header]')).toContainText('Inbox helper');
});
