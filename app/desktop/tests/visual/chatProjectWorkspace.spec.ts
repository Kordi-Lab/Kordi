import { expect, test } from '@playwright/test';

const preview = '/tests/visual/chatProjectWorkspace.html';
const introductoryMessage = 'Keep project selection in the chat. I want to organize agent sessions by project and open projects from GitHub or a local folder.';

test('Chat reopens an existing conversation and retains the original New chat and Switch Chat menu', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${preview}?theme=dark`);
  await expect(page.getByText(introductoryMessage, { exact: true })).toBeVisible();
  const main = page.getByRole('textbox', { name: 'Ask your agent…', exact: true });
  await main.fill('Keep the main conversation draft');
  const chat = page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true });
  await chat.click();
  await expect(page.locator('[data-chat-side-agent-panel]:visible')).toHaveAttribute('data-companion-session-id', 'chat-0');
  await expect(page.getByRole('complementary', { name: 'Choose side chat' })).toHaveCount(0);
  await expect(main).toHaveText('Keep the main conversation draft');
  await expect(page.getByText(introductoryMessage, { exact: true })).toBeVisible();
  await expect(page.locator('[data-chat-side-agent-panel]').getByText('Fix transcript scroll jitter', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Side chat options' }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch Chat', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('side-chat-menu-dark.png') });
  await page.getByRole('button', { name: 'Switch Chat', exact: true }).click();
  const menu = page.locator('[data-side-chat-session-list]');
  await expect(menu.locator('[data-side-chat-session-option]')).toHaveCount(10);
  await expect(menu.locator('[data-side-chat-open-in-main]')).toHaveCount(1);
  await menu.getByRole('button', { name: /Review the homepage, Switch side chat/ }).click();
  const side = page.locator('[data-chat-side-agent-panel][data-companion-session-id="chat-4"]');
  await expect(side).toBeVisible();
  await expect(side.getByText('Review the homepage', { exact: true }).last()).toBeVisible();
  await expect(main).toHaveText('Keep the main conversation draft');
  const sideComposer = side.getByRole('textbox');
  await sideComposer.fill('Keep my side chat draft');
  await chat.click();
  await chat.click();
  await expect(side).toBeVisible();
  await expect(sideComposer).toHaveText('Keep my side chat draft');
  await page.getByRole('button', { name: 'Side chat options' }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.locator('[data-chat-side-agent-panel]:visible')).toHaveAttribute('data-companion-session-id', /^preview-/);
  await expect(main).toHaveText('Keep the main conversation draft');
  await expect(page.getByText(introductoryMessage, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('full workspace groups sessions, preserves drafts and moves a session between projects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview);
  await expect(page.getByText(introductoryMessage, { exact: true })).toBeVisible();
  const kordiGroup = page.locator('.chat-project-group').filter({ hasText: 'kordi' });
  const projectRows = page.locator('[data-session-sidebar-section="project"]');
  const recentRows = page.locator('[data-session-sidebar-section="recent"]');
  const recents = page.getByRole('button', { name: 'Recents', exact: true });
  await expect(kordiGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-session-sidebar-section="pinned"]')).toHaveCount(2);
  await expect(projectRows).toHaveCount(7);
  await expect(recentRows).toHaveCount(8);
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]')).toHaveCSS('padding-left', '12px');
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]')).toHaveCSS('padding-left', '28px');
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
  const projectsHeading = page.getByRole('button', { name: 'Projects', exact: true });
  const kordiGroup = page.getByRole('button', { name: 'kordi', exact: true });
  await kordiGroup.click();
  await projectsHeading.click();
  await expect(projectsHeading).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.chat-project-group')).toHaveCount(0);
  await expect(page.locator('[data-session-sidebar-section="project"]')).toHaveCount(0);
  await expect(page.locator('[data-session-sidebar-section="recent"]')).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Project options', exact: true })).toHaveCount(0);
  await projectsHeading.press('Enter');
  await expect(projectsHeading).toHaveAttribute('aria-expanded', 'true');
  await expect(kordiGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(kordiRows).toHaveCount(0);
  await kordiGroup.click();
  await expect(kordiRows).toHaveCount(5);
  await projectsHeading.press('Space');
  await expect(projectsHeading).toHaveAttribute('aria-expanded', 'false');
  await expect(projectsHeading).toBeFocused();
  await page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(page.locator('[data-session-sidebar-section="pinned"]')).toHaveCount(3);
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="recent"]')).toHaveCount(0);
  await projectsHeading.click();
  await expect(projectsHeading).toHaveAttribute('aria-expanded', 'true');
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
    await expect(row).toHaveCSS('height', '26px');
    await expect(row.locator('.app-agent-session-preview')).toBeHidden();
    await expect(page.getByText(introductoryMessage, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}.png`) });
    await page.setViewportSize({ width: 760, height: 640 });
    await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
    await row.click();
    await expect(page.getByRole('button', { name: 'Project: kordi', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}-compact.png`) });
  });
}

test('GitHub selection and local selection update the actual sidebar and composer', async ({ page }, testInfo) => {
  await page.goto(preview);
  await page.getByRole('button', { name: 'Project: kordi', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /Clone from GitHub/ }).click();
  await page.getByRole('button', { name: /demo-workspace\/personal-site/ }).click();
  await page.screenshot({ path: testInfo.outputPath('github-import.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.locator('.chat-project-group').filter({ hasText: 'personal-site' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project: personal-site', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Project: personal-site', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project' }).getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: /Open local folder/ }).click();
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
  await page.getByRole('button', { name: /Clone from GitHub/ }).click();
  const search = page.getByRole('textbox', { name: 'Search repositories or paste a GitHub URL' });
  await search.fill('https://example.com/owner/repo');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await search.fill('https://github.com/demo-workspace/example-app');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: example-app', exact: true })).toBeVisible();
});


test('workspace controls use isolated or existing worktrees without losing a draft', async ({ page }) => {
  await page.goto(preview);
  const composer = page.getByRole('textbox', { name: 'Ask your agent…', exact: true });
  const worktree = page.getByRole('checkbox', { name: 'Use worktree' });
  const branch = page.getByRole('button', { name: 'Select branch or worktree', exact: true });
  await expect(branch).toContainText('main');
  await expect(worktree).not.toBeChecked();
  await composer.fill('Keep my worktree draft');
  await worktree.check();
  await expect(worktree).toBeChecked();
  await expect(branch).toContainText('kordi/chat-chat-2');
  await expect(composer).toHaveText('Keep my worktree draft');
  await expect(page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]')).toBeVisible();
  await worktree.uncheck();
  await expect(branch).toContainText('main');
  await branch.click();
  const menu = page.getByRole('dialog', { name: 'Select branch or worktree' });
  await menu.getByRole('button', { name: 'review/sidebar', exact: true }).click();
  await expect(branch).toContainText('review/sidebar');
  await expect(worktree).toBeChecked();
  await branch.click();
  await menu.getByRole('button', { name: 'design/sidebar', exact: true }).click();
  await expect(branch).toContainText('design/sidebar');
  await expect(composer).toHaveText('Keep my worktree draft');
  await branch.click();
  await page.keyboard.press('Escape');
  await expect(branch).toBeFocused();
  await page.getByRole('button', { name: 'Add project to chat', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add project' })).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  test(`project source dialog is compact and clear in ${theme}`, async ({ page }, testInfo) => {
    await page.goto(`${preview}?theme=${theme}`);
    await page.getByRole('button', { name: 'Add project to chat' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await expect(dialog).toHaveCSS('width', '360px');
    await expect(dialog.getByRole('heading')).toHaveCSS('font-size', '15px');
    await expect(dialog.locator('.chat-project-import-description')).toHaveCSS('font-size', '12px');
    await expect(dialog.getByRole('button', { name: /Open local folder/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Clone from GitHub/ })).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath(`project-sources-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 620 });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  });
}

test.describe('project folder motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('collapse clips rows smoothly and rapid reversal retains their identity', async ({ page }) => {
    await page.goto(preview);
    const group = page.locator('.chat-project-group').filter({ hasText: 'kordi' });
    const reveal = page.locator('[data-participant-space-block]').filter({ has: group }).locator('.app-participant-channel-reveal');
    await expect(reveal).toHaveCSS('height', '156px');
    await expect(reveal).toHaveCSS('transition-duration', '0.2s');
    const recording = reveal.evaluate(async (element) => {
      const heights: number[] = [];
      for (let i = 0; i < 24; i += 1) {
        heights.push(element.getBoundingClientRect().height);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return heights;
    });
    await group.click();
    const heights = await recording;
    expect(heights.some((height) => height > 0 && height < 155)).toBe(true);
    await expect(reveal).toHaveCSS('height', '0px');
    await group.click();
    await expect(reveal).toHaveCSS('height', '156px');
    const row = page.locator('[data-agent-session-row="chat-2"][data-session-sidebar-section="project"]');
    await row.evaluate((element) => { element.setAttribute('data-motion-identity', 'preserved'); });
    await group.click();
    await page.waitForTimeout(50);
    await group.click();
    await expect(row).toHaveAttribute('data-motion-identity', 'preserved');
    await expect(reveal).toHaveCSS('height', '156px');
  });
});
