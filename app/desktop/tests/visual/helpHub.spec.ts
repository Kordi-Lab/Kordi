import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

test('all product areas are searchable and direct navigation preserves the draft', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Help & setup' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('help-home-dark.png') });
  for (const query of ['authentication', 'cards', 'social', 'chats', 'Factory', 'connectors', 'memory', 'Digest']) {
    await page.getByRole('searchbox', { name: 'Search help' }).fill(query);
    await expect(page.locator('.help-topic').first()).toBeVisible();
  }
  await page.getByRole('searchbox', { name: 'Search help' }).fill('api key');
  await page.locator('.help-topic').filter({ hasText: 'Set up authentication' }).click();
  await page.getByRole('button', { name: 'Open authentication', exact: true }).click();
  await expect(page.getByTestId('destination')).toContainText('"tab":"auth"');
  await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Help & setup', exact: true })).toBeFocused();
});

test('introduction resumes, supports keyboard dismissal, and never marks setup complete', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  const trigger = page.getByRole('button', { name: 'Help & setup', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Step 2 of 5')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('help-introduction-light.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('button', { name: 'Resume introduction' }).click();
  await expect(page.getByText('Step 2 of 5')).toBeVisible();
  for (let step = 2; step < 5; step++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Finish introduction' }).click();
  await expect(page.getByRole('button', { name: 'Replay introduction' })).toBeVisible();
  await expect(page.getByTestId('destination')).toHaveText('null');
});

test('permissions do not prompt on open, and small windows keep controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    Notification.requestPermission = async () => { throw new Error('Unexpected request'); };
  });
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Permissions & access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow: Notifications' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('help-permissions-narrow.png') });
  await expect(page.getByRole('heading', { name: 'Card sources and sharing' })).toBeAttached();
  await page.getByRole('button', { name: 'Review cards & sharing' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Review cards & sharing' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('offline help stays readable and unavailable features explain the limitation', async ({ page }) => {
  await page.unroute('**/v1/cloud/auth/capabilities');
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.abort());
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.locator('.help-topic').filter({ hasText: 'Build and manage your cards' }).click();
  await expect(page.getByText('Could not check availability. You can still read this guide offline.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open cards in Grounding' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check availability again' })).toBeVisible();
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
  await page.goto('/tests/visual/helpHub.html');
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
    document.body.append(dialog);
  });
  await expect(invite).toHaveCount(0);
  await page.evaluate(() => document.querySelector('[role="dialog"]')!.remove());
  await expect(invite).toBeVisible();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(invite).toHaveCount(0);
});
