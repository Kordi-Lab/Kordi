import { expect, test } from '@playwright/test';

const preview = '/tests/visual/providerConnectTray.html';

for (const theme of ['light', 'dark']) {
  test(`provider tray sits on the composer and Connect opens authentication (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.goto(`${preview}?theme=${theme}`);
    const tray = page.locator('[data-provider-connect-tray]');
    const shell = page.locator('#chat-main-messages-panel .app-composer-shell');
    await expect(tray).toContainText('Connect a model to start');
    const [trayBox, shellBox] = [await tray.boundingBox(), await shell.boundingBox()];
    expect(trayBox!.height).toBe(30);
    expect(Math.round(trayBox!.y + trayBox!.height - shellBox!.y)).toBe(1);
    expect(Math.round(trayBox!.x - shellBox!.x)).toBe(22);

    const connect = tray.getByRole('button', { name: 'Connect', exact: true });
    await connect.click();
    await expect(page.locator('[data-opened-authentication]')).toHaveAttribute('data-opened-authentication', '1');
    expect(await connect.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
    await page.screenshot({ path: testInfo.outputPath(`provider-tray-${theme}.png`) });

    await page.setViewportSize({ width: 560, height: 720 });
    await expect(connect).toBeVisible();
    const text = tray.locator('.app-composer-provider-tray-text');
    expect(await text.evaluate((element) => getComputedStyle(element).textOverflow)).toBe('ellipsis');
    expect((await connect.boundingBox())!.x + 20).toBeLessThan(trayBox!.x + (await tray.boundingBox())!.width);
  });
}

test('provider tray is hidden once a provider is connected', async ({ page }) => {
  await page.goto(`${preview}?provider=1`);
  await expect(page.locator('#chat-main-messages-panel .app-composer-shell')).toBeVisible();
  await expect(page.locator('[data-provider-connect-tray]')).toHaveCount(0);
});
