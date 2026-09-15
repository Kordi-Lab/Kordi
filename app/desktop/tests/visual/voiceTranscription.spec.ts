import { test, expect } from '@playwright/test';

for (const width of [400, 900, 1280]) {
  test(`voice composer keeps its height through recording and retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/tests/visual/voiceTranscription.html');
    const shell = page.locator('.app-composer-shell');
    const baseline = await shell.boundingBox();
    expect(baseline).not.toBeNull();
    for (const state of ['Recording', 'Pending', 'Retry', 'Ready']) {
      await page.getByRole('button', { name: state, exact: true }).click();
      const bounds = await shell.boundingBox();
      expect(bounds?.height).toBe(baseline?.height);
      expect(bounds?.y).toBe(baseline?.y);
      await expect(page.getByRole('slider', { name: 'Trim voice message start' })).toHaveCount(0);
      const rail = await page.locator('.app-voice-recording-rail').boundingBox();
      const send = await page.getByRole('button', { name: state === 'Recording' ? 'Stop and send voice message' : 'Send voice message', exact: true }).boundingBox();
      expect(send!.x + send!.width).toBeLessThanOrEqual(rail!.x + rail!.width + 1);
    }
    await page.getByRole('button', { name: 'Trim voice recording', exact: true }).click();
    await expect(page.getByRole('slider', { name: 'Trim voice message start' })).toBeVisible();
    expect((await shell.boundingBox())?.height).toBe(baseline?.height);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Idle', exact: true }).click();
    expect((await shell.boundingBox())?.height).toBe(baseline?.height);
  });
}
