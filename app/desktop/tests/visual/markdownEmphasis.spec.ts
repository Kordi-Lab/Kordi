import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Fixture data only: prevent icons or links from accessing external services.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
});

for (const theme of ['dark', 'light']) {
  test(`emphasized links retain their labels and computed styles in ${theme} mode`, async ({ page }) => {
    await page.goto('/tests/visual/markdownEmphasis.html');
    await page.locator('main').evaluate((element, value) => { element.className = `kordi-app theme-${value}`; }, theme);
    for (const context of ['agent', 'human', 'compact']) {
      const column = page.locator(`[data-context="${context}"]`);
      for (let index = 0; index < 6; index += 1) {
        const section = column.locator(`[data-case="emphasis-${index}"]`);
        const link = section.getByRole('link', { name: 'Documentation', exact: true });
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAttribute('href', 'https://example.com/docs');
        const isBold = [1, 3, 4, 5].includes(index);
        const isItalic = [0, 2, 4, 5].includes(index);
        await expect(link).toHaveCSS('font-style', isItalic ? 'italic' : 'normal');
        if (isBold) expect(Number(await link.evaluate(element => getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600);
        await expect(section.locator('strong')).toHaveCount(isBold ? 1 : 0);
        await expect(section.locator('em')).toHaveCount(isItalic ? 1 : 0);
        await expect(section).not.toContainText('https://');
        await expect(section).not.toContainText('[Documentation]');
      }
      await expect(column.locator('[data-case="code"] a')).toHaveCount(0);
      await expect(column.locator('[data-case="code"] code')).toHaveText('**[Documentation](https://example.com/docs)**');
      await expect(column.locator('[data-case="plain"] a')).toHaveText('Documentation');
      if (context !== 'compact') await expect(column.locator('[data-case="list"] li li strong a')).toHaveText('Documentation');
    }
    await page.screenshot({ path: test.info().outputPath(`markdown-${theme}.png`), fullPage: true });
  });
}

test('clicking emphasized links invokes the desktop external opener', async ({ page }) => {
  const calls: { command: string; payload: unknown }[] = [];
  await page.exposeFunction('recordDesktopCall', (command: string, payload: unknown) => calls.push({ command, payload }));
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {
      invoke: (command: string, payload: unknown) => (window as unknown as {
        recordDesktopCall: (command: string, payload: unknown) => Promise<void>;
      }).recordDesktopCall(command, payload),
    } });
  });
  await page.goto('/tests/visual/markdownEmphasis.html');
  for (const link of await page.locator('[data-case^="emphasis-"] a').all()) await link.click();
  // Site icon favicon fetches share the same invoke channel; only count link-open calls.
  const openCalls = () => calls.filter((call) => call.command === 'desktop_open_external_url');
  await expect.poll(() => openCalls().length).toBe(18);
  expect(openCalls().every(call => JSON.stringify(call.payload) === JSON.stringify({ url: 'https://example.com/docs' }))).toBe(true);
  expect(page.context().pages()).toHaveLength(1);
});

test('browser clicks use the external window opener', async ({ page }) => {
  const opened: string[] = [];
  await page.exposeFunction('recordExternalUrl', (url: string) => opened.push(url));
  await page.addInitScript(() => {
    window.open = (url) => {
      void (window as unknown as { recordExternalUrl: (url: string) => Promise<void> }).recordExternalUrl(String(url));
      return null;
    };
  });
  await page.goto('/tests/visual/markdownEmphasis.html');
  await page.locator('[data-context="agent"] [data-case="emphasis-4"] a').click();
  await expect.poll(() => opened).toEqual(['https://example.com/docs']);
  expect(page.context().pages()).toHaveLength(1);
});
