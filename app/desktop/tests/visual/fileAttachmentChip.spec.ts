import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`file attachment chip renders across bubble contexts (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/fileAttachmentChip.html?theme=${theme}`);
    const contrast = await page.locator('.app-chat-bubble-user').first().evaluate((bubble) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      const luminance = (color: number[]) => color.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const styles = getComputedStyle(bubble);
      const background = rgba(styles.backgroundColor);
      const ink = luminance(rgba(styles.color));
      const surface = luminance(background);
      return { alpha: background[3], ratio: (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05) };
    });
    expect(contrast.alpha).toBe(255);
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    await expect(page.locator('[data-file-attachment-chip-fixture="true"]')).toBeVisible();
    await expect(page.locator('[data-attachment-file-chip="true"]')).toHaveCount(9);
    await expect(page).toHaveScreenshot(`fileAttachmentChip-${theme}.png`, { fullPage: true });
  });
}
