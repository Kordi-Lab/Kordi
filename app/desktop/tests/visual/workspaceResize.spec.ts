import { expect, test, type Page, type CDPSession } from '@playwright/test';

// CI macOS hosts may enable Reduce Transparency globally. Set both media
// features explicitly so each case exercises its intended material state.
const accessibilitySessions = new WeakMap<Page, CDPSession>();
async function accessibilityMedia(page: Page, contrast = 'no-preference', transparency = 'no-preference') {
  let session = accessibilitySessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    accessibilitySessions.set(page, session);
  }
  await session.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-contrast', value: contrast },
    { name: 'prefers-reduced-transparency', value: transparency },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
}
test.beforeEach(async ({ page }) => { await accessibilityMedia(page); });

async function workspaceColors(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const root = getComputedStyle(document.querySelector('.app-native-viewport')!);
    return {
      canvas: rgba(getComputedStyle(document.querySelector('.app-chat-theme-surface')!).backgroundColor),
      sessionTint: rgba(root.getPropertyValue('--app-native-session-bg').trim()),
      webSession: rgba(getComputedStyle(document.querySelector('.app-session-panel')!).backgroundColor),
    };
  });
}

for (const theme of ['light', 'dark']) {
  test(`native backing follows sidebar width and the ${theme} workspace palette`, async ({ page }) => {
    await page.goto(`/tests/visual/workspaceResize.html?backdrop=1&theme=${theme}`);
    await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests?: unknown[] }).backdropRequests?.length)).toBe(1);
    const request = await page.evaluate(() => (window as Window & { backdropRequests: { sidebarWidth: number; navigationWidth: number; background: number[]; sessionBackground: number[]; titlebarHeight: number }[] }).backdropRequests[0]);
    expect(request.sidebarWidth).toBe(320);
    expect(request.navigationWidth).toBe(48);
    expect(request.titlebarHeight).toBe(40);
    await expect(page.locator('.app-native-viewport')).toHaveAttribute('data-native-backdrop', 'ready');
    // AppKit provides the glass and tint below the transparent web surface.
    await expect(page.locator('.app-session-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const colors = await workspaceColors(page);
    expect(colors.canvas[3]).toBe(255);
    expect(request.background).toEqual(colors.canvas.slice(0, 3));
    expect(request.sessionBackground).toEqual(colors.sessionTint);
    // Native tint must preserve wallpaper color through the AppKit material.
    expect(request.sessionBackground[3]).toBeGreaterThan(0);
    expect(request.sessionBackground[3]).toBeLessThan(255);
    if (theme === 'light') {
      await page.evaluate(() => { document.body.dataset.kordiChatTheme = 'ocean'; });
      const oceanBackground = (await workspaceColors(page)).canvas.slice(0, 3);
      expect(oceanBackground).not.toEqual(request.background);
      await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests: { background: number[] }[] }).backdropRequests.at(-1)?.background)).toEqual(oceanBackground);
    }

    // Preference changes must update both AppKit and the ready web surface.
    await accessibilityMedia(page, 'more');
    await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests: { sessionBackground: number[] }[] }).backdropRequests.at(-1)?.sessionBackground[3])).toBe(255);
    await expect(page.locator('.app-session-panel')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await accessibilityMedia(page);
    await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests: { sessionBackground: number[] }[] }).backdropRequests.at(-1)?.sessionBackground[3])).toBeLessThan(255);
    await expect(page.locator('.app-session-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
}

test('session list keeps its web tint if native backing initialization fails', async ({ page }) => {
  await page.goto('/tests/visual/workspaceResize.html?backdrop=1&backdropFail=1&theme=dark');
  await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests?: unknown[] }).backdropRequests?.length)).toBe(1);
  await expect(page.locator('.app-native-viewport')).not.toHaveAttribute('data-native-backdrop', 'ready');
  const colors = await workspaceColors(page);
  expect(colors.webSession).toEqual(colors.sessionTint);
  expect(colors.webSession[3]).toBeGreaterThan(0);
  expect(colors.webSession[3]).toBeLessThan(255);
});

test('native sidebar backing follows page zoom independently of the display scale', async ({ page }) => {
  await page.goto('/tests/visual/workspaceResize.html?backdrop=1&theme=light');
  await expect(page.locator('.app-native-viewport')).toHaveAttribute('data-native-backdrop', 'ready');
  for (const zoom of [0.7, 1.6, 1]) {
    await page.evaluate(value => {
      document.documentElement.dataset.kordiInterfaceZoom = String(value);
      document.documentElement.style.setProperty('--app-interface-zoom', String(value));
      window.dispatchEvent(new Event('kordi:interface-zoom-changed'));
    }, zoom);
    await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests: { sidebarWidth: number }[] }).backdropRequests.at(-1)?.sidebarWidth)).toBe(320 * zoom);
    const request = await page.evaluate(() => (window as Window & { backdropRequests: { navigationWidth: number; titlebarHeight: number }[] }).backdropRequests.at(-1)!);
    expect(request.navigationWidth).toBe(48 * zoom);
    expect(request.titlebarHeight).toBeCloseTo(Math.max(40, 40 * zoom), 1);
    const clearance = await page.evaluate(() => {
      const button = document.querySelector('.app-native-titlebar-navigation button')!.getBoundingClientRect();
      const header = document.querySelector('.app-native-titlebar')!.getBoundingClientRect();
      return { left: button.left, bottom: button.bottom, headerBottom: header.bottom };
    });
    expect(clearance.left * zoom).toBeGreaterThanOrEqual(79.9);
    expect(clearance.bottom).toBeLessThanOrEqual(clearance.headerBottom);
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect.poll(() => page.evaluate(() => {
      const sidebar = document.querySelector('.app-side-shell')!.getBoundingClientRect();
      const titlebar = document.querySelector('.app-native-titlebar-workspace')!.getBoundingClientRect();
      return { sidebarWidth: sidebar.width, titlebarLeft: titlebar.left };
    })).toEqual({ sidebarWidth: 48, titlebarLeft: 48 });
    expect(await page.locator('.app-native-titlebar-workspace').evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft stays editable during resizing');
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.app-native-titlebar-workspace')!.getBoundingClientRect().left)).toBe(320);
  }
});

test('workspace reflows its columns and transcript without scaling text, icons, or the composer', async ({ page }) => {
  await page.goto('/tests/visual/workspaceResize.html');
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeVisible();
  await input.fill('Persistent draft');
  let wideMessageHeight = 0;
  for (const size of [{ width: 1480, height: 980 }, { width: 1192, height: 760 }, { width: 1192, height: 1040 }, { width: 1600, height: 1040 }]) {
    await page.setViewportSize(size);
    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)!.getBoundingClientRect();
        return { width: value.width, height: value.height, top: value.top, bottom: value.bottom, right: value.right };
      };
      return {
        root: rect('.app-native-viewport'), shell: rect('.app-shell'), panel: rect('.app-main-panel'),
        composer: rect('[data-testid="composer"]'), messages: rect('[data-testid="messages"]'),
        icon: rect('[data-testid="fixed-icon"]'), nav: rect('nav'), message: rect('[data-testid="messages"] p'),
        sessions: rect('.app-session-panel'),
        sessionCorner: getComputedStyle(document.querySelector('.app-session-panel')!).borderTopLeftRadius,
        font: getComputedStyle(document.querySelector('[data-testid="messages"] p')!).fontSize,
      };
    });
    expect(metrics.root.height).toBe(size.height);
    expect(metrics.shell.height).toBe(size.height);
    expect(metrics.panel.top).toBe(40);
    expect(metrics.panel.bottom).toBe(size.height - 6);
    expect(metrics.panel.right).toBe(size.width - 6);
    expect(metrics.composer.bottom).toBe(size.height - 6);
    expect(metrics.messages.bottom).toBe(metrics.composer.top);
    expect(metrics.icon.width).toBe(24);
    expect(metrics.nav.width).toBe(48);
    expect(metrics.sessions.top).toBe(40);
    expect(metrics.sessions.bottom).toBe(size.height - 6);
    expect(metrics.sessionCorner).toBe('14px');
    expect(metrics.font).toBe('15px');
    if (size.width === 1480) wideMessageHeight = metrics.message.height;
    if (size.width === 1192) expect(metrics.message.height).toBeGreaterThan(wideMessageHeight);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(input).toHaveValue('Persistent draft');
  }
});

test('vertical native growth updates the complete height chain while browser viewport metrics lag', async ({ page }) => {
  await page.setViewportSize({ width: 1192, height: 760 });
  await page.goto('/tests/visual/workspaceResize.html');
  await page.getByRole('textbox', { name: 'Message' }).focus();
  for (const height of [840, 960, 1040, 820, 760, 940, 800, 1020, 760]) {
    const measurements = await page.evaluate(height => {
      document.documentElement.style.setProperty('--app-native-height', `${height}px`);
      document.querySelector('textarea')!.scrollIntoView({ block: 'nearest' });
      const selectors = ['html', 'body', '#root', '.app-native-viewport', '.app-shell', '.app-main-panel'];
      return {
        viewport: innerHeight,
        heights: selectors.map(selector => document.querySelector(selector)!.getBoundingClientRect().height),
        composerBottom: document.querySelector('[data-testid="composer"]')!.getBoundingClientRect().bottom,
        pageScroll: document.scrollingElement!.scrollTop,
        ancestorScroll: (() => { const values = []; let node: Element | null = document.querySelector('[data-testid="composer"]'); while (node) { if (node.scrollTop) values.push({ className: node.className, scrollTop: node.scrollTop }); node = node.parentElement; } return values; })(),
      };
    }, height);
    expect(measurements.viewport).toBe(760);
    expect(measurements.heights).toEqual([760, 760, 760, height, height, height - 46]);
    expect(measurements.composerBottom, JSON.stringify(measurements.ancestorScroll)).toBe(height - 6);
    expect(measurements.pageScroll).toBe(0);
  }
});
