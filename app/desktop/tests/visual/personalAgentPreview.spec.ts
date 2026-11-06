import { expect, test } from '@playwright/test';

test('Personal agent entry, its page states, and its chat as an ordinary row', async ({ page }) => {
  await page.goto('/tests/visual/personalAgentPreview.html?status=setup');
  const entry = page.getByTestId('personal-agent-entry');
  await expect(entry).toContainText('Not set up');
  await expect(page.getByText('No messages yet')).toHaveCount(0);
  const newTop = (await page.getByRole('button', { name: 'New session' }).boundingBox())!.y;
  expect((await entry.boundingBox())!.y).toBeGreaterThan(newTop);
  await entry.click();
  const personal = page.getByTestId('personal-agent-page');
  await expect(personal).toContainText('Add a connector to turn it on.');
  await expect(personal.getByRole('switch')).toBeDisabled();

  await page.goto('/tests/visual/personalAgentPreview.html?status=off&page=1');
  await expect(page.getByTestId('personal-agent-entry')).toContainText('Off');
  await expect(personal.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await personal.getByRole('switch').click();
  await expect(personal).toContainText('Watching 3 sources');
  await expect(page.getByTestId('personal-agent-entry')).toContainText('Watching 3 sources');

  // A reach-out opens the agent's chat, an ordinary row in the list.
  await personal.getByRole('button', { name: /Lab sync moved/ }).click();
  await expect(personal).toHaveCount(0);
  const header = page.locator('[data-personal-agent-header]');
  await expect(header).toContainText("Alex's Kordi");
  const chips = page.getByRole('list', { name: 'Sources' }).last().getByRole('listitem');
  await expect(chips).toHaveText([/^Calendar\s*Lab sync$/, /^GitHub\s*#412 review requested$/]);
  const row = page.locator('[data-agent-session-row*=":personal:cloud-agent:"]');
  await expect(row).toHaveCount(1);
  await row.click({ button: 'right' });
  await expect(page.locator('[data-session-context-action]')).toHaveText(['Mark as unread', 'Mute', 'Agent settings']);
});
