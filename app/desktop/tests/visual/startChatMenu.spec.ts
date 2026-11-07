import { expect, test, type Locator, type Page } from '@playwright/test';

const preview = '/tests/visual/startChatMenu.html';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

async function rowBox(row: Locator) {
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

for (const theme of ['light', 'dark'] as const) {
  test(`Start a chat uses the Help menu surface and rows (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 560 });
    await page.goto(`${preview}?theme=${theme}&show=both`);
    const create = page.locator('[data-create-surface="side-popover"]');
    const help = page.getByRole('dialog', { name: 'Help', exact: true });
    await expect(create).toHaveAccessibleName('Start a chat');
    await expect(help).toBeVisible();
    await settle(page);

    const [createBox, helpBox] = [await rowBox(create), await rowBox(help)];
    // Start a chat keeps the Help surface but is narrower: its four actions are short.
    expect(createBox.width).toBeCloseTo(196, 1);
    expect(helpBox.width).toBeGreaterThan(createBox.width);
    const styles = await page.evaluate(() => {
      const read = (element: Element | null) => {
        const style = getComputedStyle(element!);
        return { radius: style.borderRadius, padding: style.padding, background: style.backgroundColor, shadow: style.boxShadow };
      };
      return { create: read(document.querySelector('[data-create-surface]')), help: read(document.querySelector('.help-menu')) };
    });
    expect(styles.create).toEqual(styles.help);

    const createRows = create.locator('.app-dense-menu-items > button');
    await expect(createRows).toHaveText(['Chat with contact', 'Chat with agent', 'Start group', 'Add contacts']);
    const helpRow = await rowBox(help.getByRole('button', { name: 'Show me around' }));
    for (const row of await createRows.all()) {
      const box = await rowBox(row);
      expect(box.height).toBeCloseTo(helpRow.height, 1);
      expect(box.width).toBeCloseTo(createBox.width - 12, 1);
      await expect(row).toHaveCSS('font-size', '12px');
      await expect(row.locator('svg').first()).toHaveCSS('width', '14px');
    }
    await page.screenshot({ path: test.info().outputPath(`start-chat-and-help-${theme}.png`) });
  });
}

test('Help menu Download for Mac row uses the dense row style', async ({ page }) => {
  await page.goto(`${preview}?theme=light&show=help&macDownload=1`);
  const help = page.getByRole('dialog', { name: 'Help', exact: true });
  await expect(help).toBeVisible();
  await settle(page);
  const download = help.getByRole('button', { name: 'Download for Mac', exact: true });
  const reference = await rowBox(help.getByRole('button', { name: 'Show me around' }));
  const box = await rowBox(download);
  expect(box.height).toBeCloseTo(reference.height, 1);
  expect(box.width).toBeCloseTo(reference.width, 1);
  await expect(download).toHaveCSS('font-size', '12px');
  await expect(download.locator('svg')).toHaveCSS('width', '14px');
  await download.click();
  await expect(page.getByTestId('started')).toHaveText('mac-download');
  await expect(help).toHaveCount(0);
});

test('Start a chat menu keyboard: first row focus, Tab cycles, Escape returns to +', async ({ page }) => {
  await page.goto(`${preview}?theme=dark&show=none`);
  const plus = page.getByRole('button', { name: 'Start a chat', exact: true });
  await plus.click();
  const menu = page.getByRole('dialog', { name: 'Start a chat', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Chat with contact' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Chat with agent' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('button', { name: 'Close create chat' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('button', { name: 'Add contacts' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(plus).toBeFocused();

  await plus.click();
  await page.getByRole('button', { name: 'Start group' }).press('Enter');
  await expect(page.getByRole('dialog', { name: 'Start group', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Start a chat', exact: true }).getByRole('button', { name: 'Chat with contact' })).toBeFocused();
  await page.getByRole('button', { name: 'Chat with agent' }).click();
  await page.getByRole('button', { name: /Kordi/ }).click();
  await expect(page.getByTestId('started')).toHaveText('agent:Kordi');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// Copying works without clipboard permission prompts in the preview.
async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied?: string }).copied = text; } } });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Start group needs a name, uses dense people rows and invites with a link (${theme})`, async ({ page }) => {
    await stubClipboard(page);
    await page.goto(`${preview}?theme=${theme}&mode=group&show=create`);
    const dialog = page.getByRole('dialog', { name: 'Start group', exact: true });
    await expect(dialog).toBeVisible();
    await settle(page);
    // The detail view keeps its own width; only the action menu is narrow.
    expect((await rowBox(dialog)).width).toBeCloseTo(284, 1);
    await expect(dialog.getByText('Kordi contact')).toHaveCount(0);
    await expect(dialog.getByText(/Select at least|Pick \d|verified group admin/)).toHaveCount(0);
    const people = dialog.getByRole('group', { name: 'People' });
    const maya = people.getByRole('button', { name: 'Maya Chen' });
    const box = await rowBox(maya);
    expect(box.height).toBeLessThanOrEqual(32);
    await expect(maya).toHaveCSS('font-size', '12px');

    // The name comes first: it has focus, and both actions wait for it.
    const name = dialog.getByRole('textbox', { name: 'Group name' });
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('placeholder', 'Group name');
    const invite = people.getByRole('button', { name: /Invite with a link/ });
    const create = dialog.getByRole('button', { name: 'Create group', exact: true });
    await expect(invite).toBeDisabled();
    await expect(create).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath(`start-group-empty-${theme}.png`) });
    await name.fill('   ');
    await expect(create).toBeDisabled();
    await name.fill('Launch QA');
    await expect(invite).toBeEnabled();
    await expect(create).toBeEnabled();

    await maya.focus();
    await page.keyboard.press('Space');
    await expect(maya).toHaveAttribute('aria-pressed', 'true');
    await expect(name).toHaveValue('Launch QA');
    await settle(page);
    await page.screenshot({ path: test.info().outputPath(`start-group-named-${theme}.png`) });
    await page.keyboard.press('Space');
    await expect(maya).toHaveAttribute('aria-pressed', 'false');

    await invite.click();
    await expect(page.getByTestId('started')).toHaveText('group:0:link:Launch QA');
    const shared = page.getByRole('dialog', { name: 'Launch QA', exact: true });
    await expect(shared.getByRole('textbox', { name: 'Group invitation link' })).toHaveValue(/\/g\/kordi_gi_/);
    await expect(shared.getByText('Expires in 7 days')).toBeVisible();
    const copy = shared.getByRole('button', { name: 'Copy link', exact: true });
    const [sharedBox, copyBox] = [await rowBox(shared), await rowBox(copy)];
    expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(sharedBox.x + sharedBox.width - 8);
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(shared.getByRole('button', { name: 'Link copied', exact: true })).toBeVisible();
    const toast = page.getByRole('status').filter({ hasText: 'Link copied' });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => (window as unknown as { copied?: string }).copied)).toMatch(/\/g\/kordi_gi_/);
    await settle(page);
    await page.screenshot({ path: test.info().outputPath(`start-group-link-copied-${theme}.png`) });
    await expect(page.getByRole('status').filter({ hasText: 'Link copied' })).toHaveCount(0, { timeout: 3_000 });
    await expect(shared.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
    await shared.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('Start group creates a named group with only its creator on Enter and closes', async ({ page }) => {
  await page.goto(`${preview}?theme=light&mode=group&show=create`);
  const dialog = page.getByRole('dialog', { name: 'Start group', exact: true });
  await expect(dialog).toBeVisible();
  const name = dialog.getByRole('textbox', { name: 'Group name' });
  await name.press('Enter');
  await expect(page.getByTestId('started')).toHaveText('');
  await name.fill('Launch QA');
  await name.press('Enter');
  await expect(page.getByTestId('started')).toHaveText('group:0:Launch QA');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Start group photo menu opens whole under the avatar, inside the popover (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 560 });
    await page.goto(`${preview}?theme=${theme}&show=create&mode=group`);
    const popover = page.locator('[data-create-surface="side-popover"]');
    await expect(popover).toHaveAccessibleName('Start group');
    await settle(page);
    const avatar = popover.getByRole('button', { name: 'Edit group avatar' });
    await avatar.click();
    const menu = page.getByRole('menu', { name: 'Group avatar' });
    const upload = menu.getByRole('menuitem', { name: 'Upload photo' });
    await expect(upload).toBeVisible();
    await settle(page);

    const [menuBox, popoverBox, avatarBox, uploadBox] = await Promise.all([menu, popover, avatar, upload].map(rowBox));
    expect(menuBox.x).toBeCloseTo(avatarBox.x, 0);
    expect(menuBox.y).toBeGreaterThan(avatarBox.y + avatarBox.height);
    expect(menuBox.x).toBeGreaterThanOrEqual(popoverBox.x);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(popoverBox.x + popoverBox.width);
    // The whole label shows: nothing in the row is cut off.
    const clipped = await upload.evaluate((row) => row.scrollWidth > row.clientWidth
      || document.elementFromPoint(row.getBoundingClientRect().left + 4, row.getBoundingClientRect().top + 4)?.closest('[role="menu"]') === null);
    expect(clipped).toBe(false);
    expect(uploadBox.height).toBeCloseTo(28, 0);
    await expect(upload).toHaveCSS('font-size', '12px');
    const surfaces = await page.evaluate(() => {
      const read = (element: Element | null) => {
        const style = getComputedStyle(element!);
        return { radius: style.borderRadius, padding: style.padding, background: style.backgroundColor, border: style.borderColor };
      };
      return { menu: read(document.querySelector('[data-group-avatar-menu]')), popover: read(document.querySelector('[data-create-surface]')) };
    });
    // The Help menu surface; the menu keeps the dense 5px inset of the action list.
    expect({ ...surfaces.menu, padding: surfaces.popover.padding }).toEqual(surfaces.popover);
    expect(surfaces.menu.padding).toBe('5px');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(avatar).toBeFocused();
    await expect(popover).toBeVisible();
  });
}
