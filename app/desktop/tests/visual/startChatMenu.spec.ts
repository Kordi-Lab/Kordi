import { expect, test, type Locator } from '@playwright/test';

const preview = '/tests/visual/startChatMenu.html';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

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
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

    const [createBox, helpBox] = [await rowBox(create), await rowBox(help)];
    expect(createBox.width).toBeCloseTo(helpBox.width, 1);
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
      expect(box.width).toBeCloseTo(helpRow.width, 1);
      await expect(row).toHaveCSS('font-size', '12px');
      await expect(row.locator('svg').first()).toHaveCSS('width', '14px');
    }
    await page.screenshot({ path: test.info().outputPath(`start-chat-and-help-${theme}.png`) });
  });
}

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
