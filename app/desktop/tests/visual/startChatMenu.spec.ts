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

for (const theme of ['light', 'dark'] as const) {
  test(`Start group uses dense people rows and invites with a link (${theme})`, async ({ page }) => {
    await page.goto(`${preview}?theme=${theme}&mode=group&show=create`);
    const dialog = page.getByRole('dialog', { name: 'Start group', exact: true });
    await expect(dialog).toBeVisible();
    await settle(page);
    await expect(dialog.getByText('Kordi contact')).toHaveCount(0);
    await expect(dialog.getByText(/Select at least|Pick \d/)).toHaveCount(0);
    const people = dialog.getByRole('group', { name: 'People' });
    const maya = people.getByRole('button', { name: 'Maya Chen' });
    const box = await rowBox(maya);
    expect(box.height).toBeLessThanOrEqual(32);
    await expect(maya).toHaveCSS('font-size', '12px');

    // One person can start a group: nobody else needs to be picked.
    const invite = people.getByRole('button', { name: /Invite with a link/ });
    await expect(invite).toBeEnabled();
    await expect(dialog.getByRole('textbox', { name: 'Group name' })).toHaveAttribute('placeholder', 'New group');
    await expect(dialog.getByRole('button', { name: 'Create group', exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`start-group-${theme}.png`) });

    await maya.focus();
    await page.keyboard.press('Space');
    await expect(maya).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('textbox', { name: 'Group name' })).toHaveAttribute('placeholder', 'Maya Chen');
    await page.keyboard.press('Space');
    await expect(maya).toHaveAttribute('aria-pressed', 'false');

    await invite.click();
    await expect(page.getByTestId('started')).toHaveText('group:0:link');
    const shared = page.getByRole('dialog', { name: 'New group', exact: true });
    await expect(shared.getByRole('textbox', { name: 'Group invitation link' })).toHaveValue(/\/g\/kordi_gi_/);
    await expect(shared.getByText('Expires in 7 days')).toBeVisible();
    await expect(shared.getByRole('button', { name: 'Copy invitation link' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`start-group-link-${theme}.png`) });
    await shared.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('Start group creates a group with only its creator', async ({ page }) => {
  await page.goto(`${preview}?theme=light&mode=group&show=create`);
  const dialog = page.getByRole('dialog', { name: 'Start group', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByTestId('started')).toHaveText('group:0');
});
