import { expect, test, type Page } from '@playwright/test';
import process from 'node:process';
import { installApiFixture } from './apiFixture';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DAY = 24 * 60 * 60 * 1000;

const welcome = (page: Page) => page.getByRole('complementary', { name: 'Welcome to Kordi', exact: true });
const macCard = (page: Page) => page.getByRole('complementary', { name: 'Kordi for Mac', exact: true });
const helpButton = (page: Page) => page.getByRole('button', { name: /^Help & setup/ });
const helpMenu = (page: Page) => page.getByRole('dialog', { name: 'Help', exact: true });
const shot = (name: string) => process.env.KORDI_MAC_PROMPT_SHOTS ? `${process.env.KORDI_MAC_PROMPT_SHOTS}/${name}` : undefined;

/** Moves the stored dismissal back, as if the given time had passed. */
async function ageDismissal(page: Page, ms: number) {
  await page.evaluate((age) => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('kordi.mac-app-prompt.v1:')) continue;
      const { dismissedAt } = JSON.parse(localStorage.getItem(key)!) as { dismissedAt: number };
      localStorage.setItem(key, JSON.stringify({ dismissedAt: dismissedAt - age }));
    }
  }, ms);
}

test.describe('in a Mac browser', () => {
  test.use({ userAgent: MAC_CHROME });

  test('the Mac card waits for the welcome prompt, then Not now hides it across reloads', async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await installApiFixture(page, baseURL!, true);
    await page.goto('/app/?welcome=1');
    await expect(welcome(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(macCard(page)).toHaveCount(0);

    await welcome(page).getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(macCard(page)).toBeVisible();
    await expect(macCard(page)).toBeInViewport({ ratio: 1 });
    await expect(macCard(page).getByRole('link', { name: 'Download for Mac', exact: true })).toHaveAttribute('href', '/download/mac');
    await page.screenshot({ animations: 'disabled', path: shot(`card-1440-${testInfo.project.name}.png`) ?? testInfo.outputPath('card-1440.png') });

    await macCard(page).getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(macCard(page)).toHaveCount(0);
    await page.reload();
    await expect(helpButton(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(macCard(page)).toHaveCount(0);

    await helpButton(page).click();
    const download = helpMenu(page).getByRole('button', { name: 'Download for Mac', exact: true });
    await expect(download).toBeVisible();
    await expect(macCard(page)).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: shot(`help-menu-1440-${testInfo.project.name}.png`) ?? testInfo.outputPath('help-menu-1440.png') });
    await helpMenu(page).getByRole('button', { name: 'Close help', exact: true }).click();

    // Seven days later it comes back.
    await ageDismissal(page, 6 * DAY);
    await page.reload();
    await expect(helpButton(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(macCard(page)).toHaveCount(0);
    await ageDismissal(page, DAY);
    await page.reload();
    await expect(macCard(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the Mac card never shows during the tour', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installApiFixture(page, baseURL!, true);
    await page.goto('/app/?welcome=1');
    await welcome(page).getByRole('button', { name: 'Explore Kordi', exact: true }).click();
    await expect(page.locator('.help-tour-card[data-positioned="true"]')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await expect(macCard(page)).toHaveCount(0);
  });

  test('Download for Mac fetches the installer path and snoozes the card', async ({ page, baseURL, browserName }) => {
    // Playwright WebKit does not surface a download for a fulfilled route, so it checks the request only.
    const expectDownload = async (start: () => Promise<void>) => {
      const download = browserName === 'chromium' ? page.waitForEvent('download') : null;
      await start();
      if (download) expect((await download).suggestedFilename()).toBe('Kordi.dmg');
    };
    await page.setViewportSize({ width: 1440, height: 960 });
    await installApiFixture(page, baseURL!, true);
    const requested: string[] = [];
    await page.route('**/download/mac', route => {
      requested.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, body: 'installer', headers: {
        'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Kordi.dmg"' } });
    });
    await page.goto('/app/');
    await expect(macCard(page)).toBeVisible();
    await expectDownload(() => macCard(page).getByRole('link', { name: 'Download for Mac', exact: true }).click());
    await expect.poll(() => requested).toEqual(['/download/mac']);
    await expect(page).toHaveURL(/\/app\//);
    await expect(macCard(page)).toHaveCount(0);

    await page.reload();
    await expect(helpButton(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(macCard(page)).toHaveCount(0);
    await helpButton(page).click();
    await expectDownload(() => helpMenu(page).getByRole('button', { name: 'Download for Mac', exact: true }).click());
    await expect.poll(() => requested).toEqual(['/download/mac', '/download/mac']);
    await expect(page).toHaveURL(/\/app\//);
    await expect(helpMenu(page)).toHaveCount(0);
  });
});

for (const [name, userAgent, width] of [['a phone', IPHONE, 390], ['Windows', WINDOWS, 1440]] as const) {
  test.describe(`on ${name}`, () => {
    test.use({ userAgent });

    test(`there is no Mac card or Help menu row at ${width}px`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      await installApiFixture(page, baseURL!, true);
      await page.goto('/app/');
      await expect(helpButton(page)).toBeVisible();
      await page.waitForTimeout(1_000);
      await expect(macCard(page)).toHaveCount(0);
      await helpButton(page).click();
      await expect(helpMenu(page).getByRole('button', { name: 'What’s new', exact: true })).toBeVisible();
      await expect(helpMenu(page).getByRole('button', { name: 'Download for Mac', exact: true })).toHaveCount(0);
    });
  });
}
