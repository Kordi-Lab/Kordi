import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { installApiFixture } from './apiFixture';
import { chatConversationId, installChatFixture, peerName } from './chatFixture';

const destinations = ['Contacts', 'Chats', 'Agent Chats', 'Factory', 'Digest'];

async function expectNavigationAndViewport(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-kordi-chat-theme', 'classic');
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).getPropertyValue('--app-palette-chroma').trim())).toBe('0');
  for (const name of destinations) {
    const link = page.getByRole('link', { name, exact: true }).first();
    await expect(link).toBeVisible();
    // Retries while the sidebar re-renders; a one-shot boundingBox can read a detached link.
    await expect(link).toBeInViewport({ ratio: 1 });
  }
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    shell: document.querySelector('.app-browser-viewport')!.getBoundingClientRect().width,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.shell).toBe(dimensions.viewport);
  // Native navigation uses buttons; hosted links must preserve the same theme colors.
  await expect.poll(() => page.locator('.app-workspace-nav-button[data-active="true"]').evaluate(link => {
    const button = document.createElement('button');
    button.className = link.className;
    button.dataset.active = 'true';
    link.parentElement!.append(button);
    const colors = { browser: getComputedStyle(link).color, desktopControl: getComputedStyle(button).color };
    button.remove();
    return colors.browser === colors.desktopControl;
  })).toBe(true);
}

test('desktop browser shell preserves primary destinations and fills the viewport', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installApiFixture(page, baseURL!, true);
  await page.goto('/app/chats');
  await expectNavigationAndViewport(page);
  await expect(page.getByText('Literature Summary Relay', { exact: true })).toHaveCount(0);
  const toolbar = page.locator('.app-browser-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Hide sidebar', exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: 'Show sidebar', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expectNavigationAndViewport(page);
  await toolbar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(page.locator('.app-browser-sidebar-dismiss')).toHaveCount(0);
  await expect.poll(async () => (await page.locator('.app-workspace-sidebar').boundingBox())!.width).toBeGreaterThan(200);
  // An empty fixture has no callable conversation. Do not invent call controls.
  await expect(page.getByRole('button', { name: /Start (voice|video) call|Start group meeting/ })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-desktop-workspace.png') });
});

test('390px browser keeps navigation and dismisses the complete sidebar with keyboard and backdrop', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApiFixture(page, baseURL!, true);
  await page.goto('/app/chats');
  await expectNavigationAndViewport(page);
  await expect(page.getByText('Literature Summary Relay', { exact: true })).toHaveCount(0);
  const toolbar = page.locator('.app-browser-toolbar');
  const open = toolbar.getByRole('button', { name: 'Show sidebar', exact: true });
  await expect(open).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-compact-workspace.png') });
  await open.click();
  await expect(page.locator('.app-browser-sidebar-dismiss')).toBeVisible();
  await expect(page.locator('.app-shell-content')).toHaveAttribute('inert', '');
  await expectNavigationAndViewport(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-compact-sidebar.png') });
  await page.keyboard.press('Escape');
  await expect(open).toBeVisible();
  await expect(page.locator('.app-shell-content')).not.toHaveAttribute('inert');
  await open.click();
  await page.locator('.app-browser-sidebar-dismiss').click({ position: { x: 340, y: 300 } });
  await expect(open).toBeVisible();
  await open.click();
  await page.getByRole('link', { name: 'Contacts', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  await expect(page.locator('.app-browser-sidebar-dismiss')).toHaveCount(0);
  await expectNavigationAndViewport(page);
});

test('encoded conversation deep link survives refresh and browser history', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  const path = `/app/chats/${encodeURIComponent('session:group:53cd35e4-1a37-4d36-95e4-1cfe63870336')}`;
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'Chats', exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}${path}`);
  await page.getByRole('link', { name: 'Digest', exact: true }).first().click();
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}${path}`);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Chats', exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}${path}`);
});

for (const width of [1440, 390]) {
  test(`real direct-chat header retains supported controls at ${width}px`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await installChatFixture(page, baseURL!);
    await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
    await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
    await expect(page.locator('.app-chat-header-title')).toContainText(peerName);
    await expectNavigationAndViewport(page);
    for (const name of ['Messages', 'Info', 'Artifacts', 'Tasks']) {
      await expect(page.getByRole('tab', { name, exact: true }).first()).toBeVisible();
    }
    // The fixture reports no Memory routes; the authentic capability gate hides it.
    await expect(page.getByRole('tab', { name: 'Memory', exact: true })).toHaveCount(0);
    for (const name of ['Start voice call', 'Start video call']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    const companion = page.getByRole('group', { name: 'Companion panel', exact: true });
    for (const name of ['Chat', 'Digest', 'Calendar']) {
      await expect(companion.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Info', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Info', exact: true }).first()).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Messages', exact: true }).first().click();
    await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
    const themeEvidence = await page.locator('.app-browser-viewport').evaluate(root => {
      const sidebar = root.querySelector('.app-workspace-sidebar')!;
      const active = root.querySelector('.app-workspace-nav-button[data-active="true"]')!;
      return { rootClass: root.className, theme: document.body.dataset.kordiChatTheme,
        rootBackground: getComputedStyle(root).backgroundColor, sidebarBackground: getComputedStyle(sidebar).backgroundColor,
        railColor: getComputedStyle(active).color, railToken: getComputedStyle(sidebar).getPropertyValue('--app-nav-rail-active-text').trim(),
        backingToken: getComputedStyle(root).getPropertyValue('--app-native-session-fallback').trim() };
    });
    await writeFile(testInfo.outputPath('rendered-theme.json'), JSON.stringify(themeEvidence, null, 2));
    await testInfo.attach('rendered-theme.json', { path: testInfo.outputPath('rendered-theme.json'), contentType: 'application/json' });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`synthetic-direct-chat-${width}.png`) });
  });
}
