import { expect, test } from '@playwright/test';

const preview = '/tests/visual/chatProjectWorkspace.html';

test('full workspace groups sessions, preserves drafts and moves a session between projects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview);
  const kordiGroup = page.locator('.chat-project-group').filter({ hasText: 'kordi' });
  await expect(kordiGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-agent-session-row]')).toHaveCount(7);
  const recents = page.getByRole('button', { name: 'Recents', exact: true });
  await expect(recents).toBeVisible();
  await expect(recents.locator('.lucide-folder')).toHaveCount(0);
  await expect(page.locator('.chat-project-group').filter({ hasText: 'No project' })).toHaveCount(0);
  await expect(page.locator('[data-agent-session-row="chat-6"]')).toHaveCSS('padding-left', '10px');
  await expect(page.locator('[data-agent-session-row="chat-2"]')).toHaveCSS('padding-left', '35px');
  await recents.click();
  await expect(page.locator('[data-agent-session-row]')).toHaveCount(6);
  await recents.click();
  await kordiGroup.click();
  await expect(page.locator('[data-agent-session-row]')).toHaveCount(3);
  await kordiGroup.click();
  await page.getByRole('textbox', { name: 'Ask your agent…', exact: true }).fill('Keep my project draft');
  await page.getByRole('button', { name: 'Project: kordi', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask your agent…', exact: true })).toHaveText('Keep my project draft');
  await expect(kordiGroup).toContainText('3');
  await expect(page.locator('.chat-project-group').filter({ hasText: 'website' })).toContainText('3');
  await page.locator('[data-agent-session-row="chat-2"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Move to project', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'No project', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible();
  await expect(page.locator('[data-agent-session-row="chat-2"]')).toHaveCSS('padding-left', '10px');
  await recents.click();
  await expect(page.locator('[data-agent-session-row="chat-2"]')).toHaveCount(0);
  await recents.click();
  await expect(page.locator('[data-agent-session-row="chat-2"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('GitHub selection and local selection update the actual sidebar and composer', async ({ page }, testInfo) => {
  await page.goto(preview);
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: /GitHub repository/ }).click();
  await page.getByRole('button', { name: /demo-workspace\/personal-site/ }).click();
  await page.screenshot({ path: testInfo.outputPath('github-import.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.locator('.chat-project-group').filter({ hasText: 'personal-site' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project: personal-site', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Project: personal-site', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /Local folder/ }).click();
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await expect(page.getByLabel('Folder path')).toHaveValue('/preview/research-notes');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: research-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('preview');
});

test('repository URL validation, dark theme and session switching work', async ({ page }, testInfo) => {
  await page.goto(`${preview}?theme=dark`);
  await page.locator('[data-agent-session-row="chat-4"]').click();
  await expect(page.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace-dark.png') });
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: /GitHub repository/ }).click();
  const search = page.getByRole('textbox', { name: 'Search repositories or paste a GitHub URL' });
  await search.fill('https://example.com/owner/repo');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await search.fill('https://github.com/demo-workspace/example-app');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: example-app', exact: true })).toBeVisible();
});
