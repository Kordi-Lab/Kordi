import { expect, test } from '@playwright/test';

const preview = '/tests/visual/chatProjectWorkspace.html';

test('full workspace groups sessions, preserves drafts and moves a session between projects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview);
  const kordiGroup = page.locator('.chat-project-group').filter({ hasText: 'kordi' });
  const projectRows = page.locator('[data-session-sidebar-section="project"]');
  const recentRows = page.locator('[data-session-sidebar-section="recent"]');
  const recents = page.getByRole('button', { name: 'Recents', exact: true });
  await expect(kordiGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-session-sidebar-section="pinned"]')).toHaveCount(2);
  await expect(projectRows).toHaveCount(7);
  await expect(recentRows).toHaveCount(8);
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]')).toHaveCSS('padding-left', '12px');
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]')).toHaveCSS('padding-left', '36px');
  await recents.click();
  await expect(recentRows).toHaveCount(0);
  await recents.click();
  await kordiGroup.click();
  await expect(projectRows).toHaveCount(2);
  await expect(recentRows).toHaveCount(8);
  await kordiGroup.click();
  await page.getByRole('textbox', { name: 'Ask your agent…', exact: true }).fill('Keep my project draft');
  await page.getByRole('button', { name: 'Project: kordi', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask your agent…', exact: true })).toHaveText('Keep my project draft');
  await kordiGroup.click();
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]')).toBeVisible();
  await page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Move to project', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'No project', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible();
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]')).toHaveCount(0);
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('project preview, pinning, header controls and search remain usable', async ({ page }) => {
  await page.goto(preview);
  const kordiRows = page.locator('[data-chat-sidebar-row^="project:kordi:"]');
  await expect(kordiRows).toHaveCount(5);
  await page.getByRole('button', { name: 'Show more in kordi', exact: true }).click();
  await expect(kordiRows).toHaveCount(7);
  await page.getByRole('button', { name: 'Show less in kordi', exact: true }).click();
  await expect(kordiRows).toHaveCount(5);
  await page.getByRole('button', { name: 'Project options', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse all projects', exact: true }).click();
  await expect(page.locator('[data-session-sidebar-section="project"]')).toHaveCount(0);
  await expect(page.locator('[data-session-sidebar-section="recent"]')).toHaveCount(8);
  await page.getByRole('button', { name: 'Project options', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Project options', exact: true })).toBeFocused();
  await page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(page.locator('[data-session-sidebar-section="pinned"]')).toHaveCount(3);
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Project options', exact: true }).click();
  await page.getByRole('button', { name: 'Expand all projects', exact: true }).click();
  await page.getByPlaceholder('Search agent conversations').fill('long conversation');
  await expect(kordiRows).toHaveCount(1);
  await expect(page.locator('.chat-project-show-more')).toHaveCount(0);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add project' })).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  test(`sidebar hierarchy and narrow layout in ${theme} appearance`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.goto(`${preview}?theme=${theme}`);
    const headings = page.locator('.chat-project-section-heading');
    await expect(headings).toHaveCount(3);
    await expect(headings.nth(0)).toContainText('Pinned');
    await expect(headings.nth(1)).toContainText('Projects');
    await expect(headings.nth(2)).toContainText('Recents');
    const row = page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]');
    await expect(row).toHaveCSS('height', '36px');
    await expect(row.locator('.app-agent-session-preview')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}.png`) });
    await page.setViewportSize({ width: 760, height: 640 });
    await expect(page.getByRole('button', { name: 'Project options', exact: true })).toBeVisible();
    await row.click();
    await expect(page.getByRole('button', { name: 'Project: kordi', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}-compact.png`) });
  });
}

test('GitHub selection and local selection update the actual sidebar and composer', async ({ page }, testInfo) => {
  await page.goto(preview);
  await page.getByRole('button', { name: 'Project: kordi', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /GitHub repository/ }).click();
  await page.getByRole('button', { name: /demo-workspace\/personal-site/ }).click();
  await page.screenshot({ path: testInfo.outputPath('github-import.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.locator('.chat-project-group').filter({ hasText: 'personal-site' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project: personal-site', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Project: personal-site', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /Local folder/ }).click();
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await expect(page.getByLabel('Folder path')).toHaveValue('/preview/research-notes');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: research-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('preview');
});

test('repository URL validation, dark theme and session switching work', async ({ page }, testInfo) => {
  await page.goto(`${preview}?theme=dark`);
  await page.locator('[data-agent-session-row="chat-4"][data-session-sidebar-section="project"]').click();
  await expect(page.getByRole('button', { name: 'Project: website', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace-dark.png') });
  await page.getByRole('button', { name: 'Project: website', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /GitHub repository/ }).click();
  const search = page.getByRole('textbox', { name: 'Search repositories or paste a GitHub URL' });
  await search.fill('https://example.com/owner/repo');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await search.fill('https://github.com/demo-workspace/example-app');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: example-app', exact: true })).toBeVisible();
});
