import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`native backing follows sidebar width and the ${theme} workspace palette`, async ({ page }) => {
    await page.goto(`/tests/visual/workspaceResize.html?backdrop=1&theme=${theme}`);
    await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests?: unknown[] }).backdropRequests?.length)).toBe(1);
    const request = await page.evaluate(() => (window as Window & { backdropRequests: { sidebarWidth: number; navigationWidth: number; background: number[]; sessionBackground: number[] }[] }).backdropRequests[0]);
    expect(request.sidebarWidth).toBe(320);
    expect(request.navigationWidth).toBe(72);
    await expect(page.locator('.app-native-viewport')).toHaveAttribute('data-native-backdrop', 'ready');
    await expect(page.locator('.app-session-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    if (theme === 'dark') expect(request.sessionBackground).toEqual([15, 17, 21, 255]);
    else expect(request.sessionBackground[3]).toBeGreaterThan(170);
    if (theme === 'dark') expect(request.background).toEqual([15, 17, 21]);
    else expect(request.background).toEqual([244, 245, 247]);
    if (theme === 'light') {
      await page.evaluate(() => { document.body.dataset.kordiChatTheme = 'ocean'; });
      await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests: { background: number[] }[] }).backdropRequests.at(-1)?.background)).toEqual([232, 240, 239]);
    }
  });
}

test('session list keeps its web tint if native backing initialization fails', async ({ page }) => {
  await page.goto('/tests/visual/workspaceResize.html?backdrop=1&backdropFail=1&theme=dark');
  await expect.poll(() => page.evaluate(() => (window as Window & { backdropRequests?: unknown[] }).backdropRequests?.length)).toBe(1);
  await expect(page.locator('.app-native-viewport')).not.toHaveAttribute('data-native-backdrop', 'ready');
  await expect(page.locator('.app-session-panel')).toHaveCSS('background-color', 'rgb(15, 17, 21)');
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
        font: getComputedStyle(document.querySelector('[data-testid="messages"] p')!).fontSize,
      };
    });
    expect(metrics.root.height).toBe(size.height);
    expect(metrics.shell.height).toBe(size.height);
    expect(metrics.panel.bottom).toBe(size.height);
    expect(metrics.panel.right).toBe(size.width);
    expect(metrics.composer.bottom).toBe(size.height);
    expect(metrics.messages.bottom).toBe(metrics.composer.top);
    expect(metrics.icon.width).toBe(24);
    expect(metrics.nav.width).toBe(72);
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
    expect(measurements.heights).toEqual([760, 760, 760, height, height, height]);
    expect(measurements.composerBottom, JSON.stringify(measurements.ancestorScroll)).toBe(height);
    expect(measurements.pageScroll).toBe(0);
  }
});
