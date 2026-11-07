import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

for (const enterWorkspace of ['Skip for now', 'Connect test provider']) {
  test(`welcome and tours wait for provider setup: ${enterWorkspace}`, async ({ page }) => {
    await page.goto('/tests/visual/helpHub.html?startup=1');
    const welcome = page.getByRole('complementary', { name: 'Welcome to Kordi' });
    await expect(page.getByRole('button', { name: /Help & setup/ })).toHaveCount(0);
    await expect(welcome).toHaveCount(0);
    await page.getByRole('button', { name: 'Finish loading providers' }).click();
    await expect(page.getByRole('heading', { name: 'Connect a provider' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Help & setup/ })).toHaveCount(0);
    await expect(welcome).toHaveCount(0);
    await expect(page.locator('.help-tour-layer')).toHaveCount(0);
    await page.getByRole('button', { name: enterWorkspace, exact: true }).click();
    await expect(page.locator('.app-auth-gate-overlay')).toHaveCount(0);
    await expect(welcome).toBeVisible();
    await page.getByRole('button', { name: 'Explore Kordi', exact: true }).click();
    await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'profile');
    await expect(welcome).toHaveCount(0);
    await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Help & setup', exact: true })).toBeVisible();
  });
}

test('help is a compact menu and direct navigation preserves the draft', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Help', exact: true });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(300);
  expect(bounds!.height).toBeLessThan(460);
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
  await expect(page.getByRole('button', { name: 'Tour sections', exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('tour-auth-light.png') });
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Cards · Step 1 of 7')).toBeVisible();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding-cards');
  await expect(page.getByRole('dialog', { name: 'Account settings' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('tour-cards-light.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('button', { name: 'Resume tour' }).click();
  await expect(page.getByText('Cards · Step 1 of 7')).toBeVisible();
  await page.getByRole('button', { name: 'Tour sections', exact: true }).click();
  await page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name: 'Help', exact: true }).click();
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
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding-cards');
  await page.screenshot({ path: test.info().outputPath('tour-cards-dark.png') });
  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(async () => {
    const bounds = await page.locator('.help-tour-card').boundingBox();
    return Boolean(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 740);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('tour-narrow.png') });
  await page.getByRole('button', { name: 'Tour sections', exact: true }).click();
  await page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'nav-contacts');
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
    let locationPermission = 'not_determined';
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.assign(window, { permissionTestCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === 'desktop_notification_permission_state') return 'denied';
        if (command === 'common_ground_device_status') return { calendar: 'granted', reminders: 'not_determined' };
        if (command === 'desktop_nearby_location_permission') {
          if (args?.request) locationPermission = 'granted';
          return locationPermission;
        }
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
  await page.getByRole('button', { name: 'Allow: Location' }).click();
  await expect(page.getByRole('button', { name: 'Open Settings: Location' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings: Location' }).click();
  await expect.poll(async () => (await calls()).some((call) => call.command === 'desktop_open_external_url' && String(call.args?.url).includes('Privacy_LocationServices'))).toBe(true);
  await page.getByRole('button', { name: 'Allow: Microphone' }).click();
  await expect(page.getByRole('button', { name: 'Open Settings: Microphone' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings: Camera' }).click();
  await expect.poll(async () => (await calls()).some((call) => call.command === 'desktop_open_external_url' && String(call.args?.url).includes('Privacy_Camera'))).toBe(true);
  await expect(page.getByText('Restricted', { exact: true })).toBeVisible();
  expect((await calls()).filter((call) => call.args?.request === true)).toHaveLength(2);
  const calendar = page.locator('.help-device-permission').filter({ has: page.getByRole('heading', { name: 'Calendar', exact: true }) });
  await expect(calendar.locator('summary')).toHaveCount(0);
  await expect(calendar.getByText('Show calendar events.', { exact: false })).toBeVisible();
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
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card).toHaveAttribute('data-target', 'grounding-cards');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  await page.locator('[data-help-target="grounding-cards"]').evaluate((node) => node.setAttribute('data-help-target', 'delayed-deck'));
  await expect(card).toHaveAttribute('data-positioned', 'false');
  await expect(card).toBeHidden();
  await page.locator('[data-help-target="delayed-deck"]').evaluate((node) => node.setAttribute('data-help-target', 'grounding-cards'));
  await expect(card).toHaveAttribute('data-positioned', 'true');
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding-cards');
});


test('tour glass respects transparency and contrast preferences', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Media feature overrides require Chromium CDP.');
  const session = await page.context().newCDPSession(page);
  await page.goto('/tests/visual/helpHub.html');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const card = page.locator('.help-tour-card');
  await expect(card).toBeVisible();
  // CI hosts may enable Reduce Transparency. Exercise each material explicitly.
  for (const [contrast, transparency, glass] of [
    ['no-preference', 'no-preference', true],
    ['no-preference', 'reduce', false],
    ['more', 'no-preference', false],
  ] as const) {
    await session.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-contrast', value: contrast },
      { name: 'prefers-reduced-transparency', value: transparency },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    await expect(card).toHaveCSS('backdrop-filter', glass ? /blur\(24px\)/ : 'none');
  }
});

test('a workspace without Grounding gets a tour of available controls and preserves resume progress', async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'] } }));
  await page.goto('/tests/visual/helpHub.html?theme=light');
  await page.locator('[data-help-target="grounding"]').evaluate((node) => node.remove());
  const trigger = page.getByRole('button', { name: 'Help & setup', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await expect(page.getByText('Authentication · Step 1 of 1')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'nav-contacts');
  await expect(page.getByRole('dialog', { name: 'Add someone to your contacts' })).toBeVisible();
  await expect(page.getByText('Contacts · Step 1 of 1')).toBeVisible();
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

test('first-open loading never paints a clipped placeholder in the navigation rail', async ({ page }) => {
  let releaseMenu!: () => void;
  let releaseTour!: () => void;
  let menuRequested!: () => void;
  let tourRequested!: () => void;
  const menuGate = new Promise<void>((resolve) => { releaseMenu = resolve; });
  const tourGate = new Promise<void>((resolve) => { releaseTour = resolve; });
  const menuRequest = new Promise<void>((resolve) => { menuRequested = resolve; });
  const tourRequest = new Promise<void>((resolve) => { tourRequested = resolve; });
  await page.route('**/src/features/onboarding/HelpMenu.tsx*', async (route) => { menuRequested(); await menuGate; await route.continue(); });
  await page.route('**/src/features/onboarding/HelpTour.tsx*', async (route) => { tourRequested(); await tourGate; await route.continue(); });
  await page.goto('/tests/visual/helpColdStart.html');
  const trigger = page.getByRole('button', { name: 'Help & setup', exact: true });
  const initial = await trigger.boundingBox();
  try {
    await trigger.click();
    await menuRequest;
    const loadingHelp = page.getByRole('status').filter({ hasText: 'Loading help…' });
    await expect(loadingHelp).toHaveCSS('position', 'absolute');
    expect((await loadingHelp.boundingBox())!.width).toBeLessThanOrEqual(1);
    expect((await trigger.boundingBox())!.y).toBe(initial!.y);
    releaseMenu();
    await page.getByRole('button', { name: 'Show me around' }).click();
    await tourRequest;
    const loadingTour = page.getByRole('status').filter({ hasText: 'Loading tour…' });
    await expect(loadingTour).toHaveCSS('position', 'absolute');
    expect((await loadingTour.boundingBox())!.width).toBeLessThanOrEqual(1);
    releaseTour();
    await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'settings-auth');
    await expect(page.getByRole('dialog', { name: 'Connect an AI account' })).toBeVisible();
  } finally { releaseMenu(); releaseTour(); }
});

test('startup welcome waits through a launch dialog without flashing first', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?welcome=1');
  const invite = page.getByRole('complementary', { name: 'Welcome to Kordi' });
  await page.evaluate(async () => {
    document.querySelector('.app-cloud-workspace-surface')!.removeAttribute('inert');
    await new Promise(requestAnimationFrame);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
  });
  await expect(invite).toHaveCount(0);
  await page.evaluate(() => document.querySelector('[role="dialog"]')!.remove());
  await expect(invite).toBeVisible();
});


test('feature tours remain discoverable when Grounding is unavailable', async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, memoryVersion: 3 } }));
  await page.goto('/tests/visual/helpHub.html?isolated=1');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Meet people with Grounding' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create and share cards' })).toBeDisabled();
  await expect(page.getByText('Grounding and cards are not enabled in this workspace yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import memory', exact: true })).toBeEnabled();
});

for (const [tour, targets] of [
  ['grounding', ['grounding', 'grounding-cards', 'grounding-pair', 'grounding-room']],
  ['cards', ['grounding-cards', 'grounding-new-card', 'grounding-documents', 'grounding-notes', 'grounding-build', 'grounding-topics', 'grounding-sharing']],
  ['imports', ['settings-memory', 'memory-import-files', 'memory-import-run', 'memory-review']],
] as const) {
  test(`${tour} tour follows real feature controls without building, sharing, or importing`, async ({ page }) => {
    await page.goto(tour === 'imports' ? '/tests/visual/memorySettings.html?tour=imports&theme=light' : `/tests/visual/commonGroundPage.html?tour=${tour}&theme=light`);
    for (const [index, target] of targets.entries()) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target, { timeout: 10000 });
      await expect(page.locator('.help-tour-card')).toBeVisible();
      await expect(page.getByText(`Step ${index + 1} of ${targets.length}`, { exact: true })).toBeVisible();
      if (index === 1) await page.screenshot({ path: test.info().outputPath(`${tour}-tour.png`) });
      if (target !== 'grounding' && page.url().includes('emptyCard')) {
        await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
        await expect(page.locator('[data-help-demo="grounding"] button').first()).toBeDisabled();
        await page.screenshot({ path: test.info().outputPath(`${tour}-${target}-example.png`) });
      }
      await page.getByRole('button', { name: index === targets.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
    }
    await expect(page.locator('.help-tour-layer')).toHaveCount(0);
    await expect(page.locator('[data-help-demo]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
  });
}

for (const theme of ['dark', 'light']) {
  test(`documents spotlight includes its label and selector in ${theme} mode`, async ({ page }) => {
    await page.goto(`/tests/visual/commonGroundPage.html?tour=cards&emptyCard=1&theme=${theme}`);
    for (const target of ['grounding-cards', 'grounding-new-card']) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    const spotlight = page.locator('.help-tour-spotlight');
    await expect(spotlight).toHaveAttribute('data-target', 'grounding-documents');
    const row = page.locator('[data-help-target="grounding-documents"]');
    await expect(row).toContainText('Documents');
    await expect(row).toContainText('1 chosen');
    await expect.poll(async () => {
      const target = await row.boundingBox();
      const ring = await spotlight.boundingBox();
      const card = await page.locator('.help-tour-card').boundingBox();
      if (!target || !ring || !card) return false;
      const containsRow = ring.x <= target.x && ring.y <= target.y
        && ring.x + ring.width >= target.x + target.width
        && ring.y + ring.height >= target.y + target.height;
      const besideRow = card.x + card.width <= ring.x || card.x >= ring.x + ring.width
        || card.y + card.height <= ring.y || card.y >= ring.y + ring.height;
      return containsRow && besideRow;
    }).toBe(true);
    await expect(spotlight).toHaveCSS('border-top-width', '2px');
    await page.screenshot({ path: test.info().outputPath(`documents-spotlight-${theme}.png`) });
  });
}

for (const tour of ['grounding', 'cards'] as const) {
  test(`${tour} tour uses temporary example cards through review and sharing`, async ({ page }) => {
    await page.goto(`/tests/visual/commonGroundPage.html?tour=${tour}&emptyCard=1&theme=light`);
    const targets = tour === 'grounding' ? ['grounding', 'grounding-cards', 'grounding-pair', 'grounding-room'] : ['grounding-cards', 'grounding-new-card', 'grounding-documents', 'grounding-notes', 'grounding-build', 'grounding-topics', 'grounding-sharing'];
    for (const [index, target] of targets.entries()) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
      if (target !== 'grounding' && page.url().includes('emptyCard')) {
        await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
        await expect(page.locator('[data-help-demo="grounding"] button').first()).toBeDisabled();
        await page.screenshot({ path: test.info().outputPath(`${tour}-${target}-example.png`) });
      }
      await page.getByRole('button', { name: index === targets.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
    }
    await expect(page.locator('.help-tour-layer')).toHaveCount(0);
    await expect(page.locator('[data-help-demo]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
  });
}

test('card section continues into Grounding inside the same main tour', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Feature tours', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create and share cards', exact: true }).click();
  for (const target of ['grounding-cards', 'grounding-new-card', 'grounding-documents', 'grounding-notes', 'grounding-build', 'grounding-topics', 'grounding-sharing']) {
    await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
    await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding-pair');
  await page.getByRole('button', { name: 'Tour sections', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name: 'Import memory', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-help-demo]')).toHaveCount(0);
});

for (const off of [false, true]) {
  test(`empty memory shows examples without importing or enabling memory (${off ? 'off' : 'on'})`, async ({ page }) => {
    await page.goto(`/tests/visual/memorySettings.html?tour=imports&emptyMemory=1${off ? '&memoryOff=1' : ''}`);
    for (const [index, target] of ['settings-memory', 'memory-import-files', 'memory-import-run', 'memory-review'].entries()) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
      if (index > 0) await expect(page.locator(`[data-help-demo="${index === 3 ? 'memories' : 'files'}"]`)).toBeVisible();
      if (index === 3) await page.screenshot({ path: test.info().outputPath('empty-memory-example.png') });
      await page.getByRole('button', { name: index === 3 ? 'Finish tour' : 'Next', exact: true }).click();
    }
    await expect(page.locator('[data-help-demo]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
    if (off) await expect(page.getByRole('switch', { name: 'Let Kordi save memories' })).not.toBeChecked();
  });
}

test('memory tour scrolls growing examples into view and clips highlights to the settings viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 600 });
  await page.goto('/tests/visual/memorySettings.html?tour=imports&emptyMemory=1&theme=light');
  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  const target = page.locator('[data-help-target="memory-review"]');
  const spotlight = page.locator('.help-tour-spotlight');
  await expect(spotlight).toHaveAttribute('data-target', 'memory-review');
  const scroller = page.locator('.app-cloud-account-settings-page > .app-scroll-area');
  await expect(scroller).toHaveAttribute('data-help-tour-scroll', '');
  // The empty-state example and asynchronous file discovery can change the layout after the step starts.
  await target.evaluate((element) => { element.style.paddingBottom = '160px'; });
  await expect.poll(async () => {
    const content = await target.boundingBox();
    const viewport = await scroller.boundingBox();
    return Boolean(content && viewport && content.y >= viewport.y && content.y + content.height <= viewport.y + viewport.height + 1);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('memory-tour-scrolled-example.png') });
  // Taller targets and smaller windows must never paint a spotlight through the dialog's edge.
  await target.evaluate((element) => { element.style.minHeight = '900px'; });
  await page.setViewportSize({ width: 1180, height: 460 });
  await expect.poll(async () => {
    const highlight = await spotlight.boundingBox();
    const viewport = await scroller.boundingBox();
    return Boolean(highlight && viewport && highlight.y >= viewport.y - 1 && highlight.y + highlight.height <= viewport.y + viewport.height + 1);
  }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-help-tour-scroll]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
});
