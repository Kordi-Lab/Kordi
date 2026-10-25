import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

test('help is a compact menu and direct navigation preserves the draft', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Help', exact: true });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(300);
  expect(bounds!.height).toBeLessThan(250);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('help-menu-dark.png') });
  await page.getByRole('button', { name: 'Permissions & access', exact: true }).click();
  await page.getByText('Services and agent access', { exact: true }).click();
  await page.getByRole('button', { name: 'Manage connectors & access', exact: true }).click();
  await expect(page.getByTestId('destination')).toContainText('"tab":"connectors"');
  await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Help & setup', exact: true })).toBeFocused();
});

test('workspace tour highlights real controls, resumes, and opens permission recovery', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  const trigger = page.getByRole('button', { name: 'Help & setup', exact: true });
  await trigger.click();
  await page.screenshot({ path: test.info().outputPath('workspace-help-menu-light.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Show me around' }).click();
  await expect(page.getByRole('dialog', { name: 'Help', exact: true })).toHaveCount(0);
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'settings-auth');
  await expect(page.getByRole('dialog', { name: 'Account settings' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Connect an AI account' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close tour', exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('tour-auth-light.png') });
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Step 2 of 7')).toBeVisible();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding');
  await expect(page.getByRole('dialog', { name: 'Account settings' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('tour-cards-light.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('button', { name: 'Resume tour' }).click();
  await expect(page.getByText('Step 2 of 7')).toBeVisible();
  for (let step = 2; step < 7; step++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'help');
  await page.getByRole('button', { name: 'Open Permissions & access' }).click();
  await expect(page.getByRole('heading', { name: 'Permissions & access', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to help menu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replay tour' })).toBeVisible();
});

test('spotlight follows resizing and handles disappearing controls', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding');
  await page.screenshot({ path: test.info().outputPath('tour-cards-dark.png') });
  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(async () => {
    const bounds = await page.locator('.help-tour-card').boundingBox();
    return Boolean(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 740);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('tour-narrow.png') });
  await page.locator('[data-help-target="grounding"]').evaluate((node) => node.removeAttribute('data-help-target'));
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'nav-contacts');
  await expect(page.getByText('Step 2 of 6')).toBeVisible();
  await expect(page.getByText('This control is not visible', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect(page.locator('.help-tour-layer')).toHaveCount(0);
});

test('permissions do not prompt on open, and small windows keep controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    Notification.requestPermission = async () => { throw new Error('Unexpected request'); };
  });
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Permissions & access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow: Notifications' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('help-permissions-narrow.png') });
  await page.getByText('Card sources and sharing', { exact: true }).click();
  await page.getByRole('button', { name: 'Review cards & sharing' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Review cards & sharing' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the compact menu and tour remain available offline', async ({ page }) => {
  await page.unroute('**/v1/cloud/auth/capabilities');
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.abort());
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'settings-auth');
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Permissions & access', exact: true }).click();
  await page.getByText('Services and agent access', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage connectors & access' })).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(page.locator('.help-menu')).toContainText('Permissions & access');
});

test('native permissions request only on Allow and recover through Settings', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let microphone = 'not_determined';
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.assign(window, { permissionTestCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === 'desktop_notification_permission_state') return 'denied';
        if (command === 'common_ground_device_status') return { calendar: 'granted', reminders: 'not_determined' };
        if (command === 'desktop_media_permission') {
          if (args?.source === 'microphone') {
            if (args.request) microphone = 'granted';
            return microphone;
          }
          return args?.source === 'camera' ? 'denied' : 'restricted';
        }
        if (command === 'desktop_tool_approval_pending') return [];
        return null;
      },
    } });
  });
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Permissions & access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow: Microphone' })).toBeVisible();
  const calls = () => page.evaluate(() => (window as unknown as { permissionTestCalls: Array<{ command: string; args?: Record<string, unknown> }> }).permissionTestCalls);
  expect((await calls()).some((call) => call.args?.request === true || call.command === 'desktop_request_notification_permission')).toBe(false);
  await page.getByRole('button', { name: 'Allow: Microphone' }).click();
  await expect(page.getByRole('button', { name: 'Open Settings: Microphone' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings: Camera' }).click();
  await expect.poll(async () => (await calls()).some((call) => call.command === 'desktop_open_external_url' && String(call.args?.url).includes('Privacy_Camera'))).toBe(true);
  await expect(page.getByText('Restricted by this device')).toBeVisible();
  expect((await calls()).filter((call) => call.args?.request === true)).toHaveLength(1);
  const calendar = page.locator('.help-device-permission').filter({ has: page.getByRole('heading', { name: 'Calendar', exact: true }) });
  await calendar.locator('summary').click();
  await calendar.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('permission-explanation.png'), animations: 'disabled' });
});

test('signup invitation waits for startup and dialogs and survives a collapsed rail', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?welcome=1');
  const invite = page.getByRole('complementary', { name: 'Welcome to Kordi' });
  await expect(invite).toHaveCount(0);
  await page.evaluate(() => document.querySelector('.app-cloud-workspace-surface')!.removeAttribute('inert'));
  await expect(invite).toBeVisible();
  const bounds = await invite.boundingBox();
  expect(bounds!.width).toBeGreaterThan(200);
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.querySelector('.kordi-app')!.append(dialog);
  });
  await expect(invite).toHaveCount(0);
  await page.evaluate(() => document.querySelector('[role="dialog"]')!.remove());
  await expect(invite).toBeVisible();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(invite).toHaveCount(0);
});

test('a delayed tour target never sends the glass popover to the middle of the window', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const card = page.locator('.help-tour-card');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  const before = await card.boundingBox();
  await page.locator('[data-help-target="grounding"]').evaluate((node) => node.removeAttribute('data-help-target'));
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card).toHaveAttribute('data-target', 'grounding');
  await expect(card).toHaveAttribute('data-positioned', 'false');
  await expect(card).toBeHidden();
  const waiting = await card.evaluate((node) => ({ x: node.getBoundingClientRect().x }));
  expect(Math.abs(waiting!.x - before!.x)).toBeLessThan(2);
  expect(await card.evaluate((node) => getComputedStyle(node).backdropFilter)).toContain('blur(');
  await page.locator('.app-common-ground-row').evaluate((node) => node.setAttribute('data-help-target', 'grounding'));
  await expect(card).toHaveAttribute('data-positioned', 'true');
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding');
});


test('a workspace without Grounding gets a tour of available controls and preserves resume progress', async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'] } }));
  await page.goto('/tests/visual/helpHub.html?theme=light');
  await page.locator('[data-help-target="grounding"]').evaluate((node) => node.remove());
  const trigger = page.getByRole('button', { name: 'Help & setup', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await expect(page.getByText('Step 1 of 6')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'nav-contacts');
  await expect(page.getByRole('dialog', { name: 'Add someone to your contacts' })).toBeVisible();
  await expect(page.getByText('Step 2 of 6')).toBeVisible();
  await page.keyboard.press('Escape');
  await trigger.click();
  await page.getByRole('button', { name: 'Resume tour' }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'nav-contacts');
  await page.getByRole('button', { name: 'Previous step' }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'settings-auth');
});

test('installed release highlights work offline with one sentence-case heading', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string) => command === 'plugin:app|version' ? '0.0.2-beta.5.2' : null,
    } });
  });
  await page.route('**/releases/**', (route) => route.abort());
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'What’s new', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What’s new', exact: true })).toHaveCount(1);
  await expect(page.getByText('Read, edit, and share documents together', { exact: true })).toBeVisible();
  await expect(page.getByText('RELEASE HIGHLIGHTS', { exact: true })).toHaveCount(0);
});
