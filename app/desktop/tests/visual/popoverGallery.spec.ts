import { expect, test, type Locator, type Page } from '@playwright/test';

const gallery = '/tests/visual/popoverGallery.html';
// KORDI_POPOVER_SHOTS writes the per-menu captures to a review folder instead of the test output.
const shotDirectory = process.env.KORDI_POPOVER_SHOTS;

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

function surfaces(page: Page): Record<string, Locator> {
  const account = page.locator('[role="dialog"][aria-label="Account menu"]');
  return {
    help: page.locator('.help-menu'),
    account: account.filter({ hasNot: page.locator('.org-menu-panel') }),
    organizations: account.filter({ has: page.locator('.org-menu-panel') }),
    session: page.locator('[data-gallery="session"] > div > div'),
    group: page.locator('[data-gallery="group"] > div > div'),
    personal: page.locator('[data-gallery="personal"] [role="menu"]'),
    attachment: page.locator('[data-attachment-image-context-menu]'),
    message: page.locator('[data-gallery="message"] [data-message-context-menu-content] > div').last(),
    'composer-add': page.locator('[data-composer-attachment-add-menu]'),
    model: page.locator('.app-model-picker'),
  };
}

async function openGallery(page: Page, theme: 'light' | 'dark') {
  await page.setViewportSize({ width: 1600, height: 980 });
  await page.goto(`${gallery}?theme=${theme}`);
  await expect(page.locator('[data-gallery-ready]')).toBeVisible();
  for (const surface of Object.values(surfaces(page))) await expect(surface).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

function shotPath(name: string) {
  return shotDirectory ? `${shotDirectory}/${name}.png` : test.info().outputPath(`${name}.png`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`capture every pop-up menu (${theme})`, async ({ page }) => {
    await openGallery(page, theme);
    await page.screenshot({ path: shotPath(`gallery-${theme}`) });
    for (const [name, surface] of Object.entries(surfaces(page))) {
      await surface.screenshot({ path: shotPath(`${name}-${theme}`), animations: 'disabled' });
    }
  });

  test(`capture the side chat options menu (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/chatProjectWorkspace.html?destinations=1&theme=${theme}`);
    await page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await page.locator('[data-chat-side-agent-panel]:visible').getByRole('button', { name: 'Side chat options' }).click();
    const menu = page.locator('[data-side-chat-options-menu]');
    await expect(menu).toBeVisible();
    await settle(page);
    await menu.screenshot({ path: shotPath(`side-chat-${theme}`), animations: 'disabled' });
  });

  test(`capture the chat project picker (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/chatProjectWorkspace.html?theme=${theme}`);
    await page.getByRole('button', { name: 'Project: kordi', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Choose project' });
    await expect(menu).toBeVisible();
    await settle(page);
    await menu.screenshot({ path: shotPath(`project-${theme}`), animations: 'disabled' });
  });

  test(`every pop-up menu uses the Help menu surface and rows (${theme})`, async ({ page }) => {
    await openGallery(page, theme);
    const read = (locator: Locator) => locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, border: `${style.borderTopWidth} ${style.borderTopColor}`, background: style.backgroundColor, shadow: style.boxShadow, filter: style.backdropFilter };
    });
    const all = surfaces(page);
    const reference = await read(all.help);
    for (const [name, surface] of Object.entries(all)) {
      expect(await read(surface), name).toEqual(reference);
    }
    const helpRow = await all.help.getByRole('button', { name: 'Show me around' }).boundingBox();
    for (const name of ['account', 'organizations', 'session', 'group', 'personal', 'attachment', 'message', 'composer-add'] as const) {
      const rows = all[name].locator('.app-dense-menu-row, .app-dense-menu-items > button');
      expect(await rows.count(), name).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        await expect(row, name).toHaveCSS('font-size', '12px');
        await expect(row, name).toHaveCSS('border-radius', '6px');
        const box = await row.boundingBox();
        expect(box!.height, `${name}: ${await row.innerText()}`).toBeCloseTo(helpRow!.height, 0);
      }
    }
  });

  test(`menu focus shows the hover fill, never a ring (${theme})`, async ({ page }) => {
    await openGallery(page, theme);
    const all = surfaces(page);
    // The organization list focuses the current organization as it opens.
    const current = all.organizations.locator('[aria-pressed="true"]');
    await expect(current).toBeFocused();
    await expect(current).toHaveCSS('outline-style', 'none');
    for (const [name, surface] of Object.entries(all)) {
      const hover = await surface.evaluate((element) => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--app-transient-hover-bg)';
        element.append(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      });
      const controls = surface.locator('.app-dense-menu-row:not(.app-dense-menu-danger):not(:disabled), .app-dense-menu-items > button:not(:disabled), .app-model-picker-row:not(:disabled), .app-dense-menu-header > button');
      expect(await controls.count(), name).toBeGreaterThan(0);
      for (const control of (await controls.all()).slice(0, 4)) {
        await control.focus();
        await expect(control, name).toBeFocused();
        await expect(control, name).toHaveCSS('outline-style', 'none');
        await expect(control, name).toHaveCSS('background-color', hover);
      }
    }
  });
}
