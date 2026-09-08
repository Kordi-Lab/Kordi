import { expect, test } from '@playwright/test';

test('standalone emoji receipts stay beside the image and align with text receipt insets', async ({ page }) => {
  await page.goto('/tests/visual/emojiDeliveryAlignment.html');
  const emoji = page.locator('.app-standalone-emoji-message');
  await expect(emoji).toHaveCount(15);
  await expect(emoji.first()).toHaveCSS('display', 'inline-flex');
  const geometry = await emoji.evaluateAll(elements => elements.map(element => {
    const picture = element.firstElementChild!.getBoundingClientRect();
    const receipt = element.querySelector('.app-message-delivery-footer')!.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return { gap: receipt.left - picture.right, bottom: receipt.bottom - picture.bottom,
      inset: frame.right - receipt.right, width: frame.width, height: frame.height, right: receipt.right };
  }));
  const textRight = await page.locator('.reference-text .app-message-delivery-footer').evaluate(element => element.getBoundingClientRect().right);
  for (const rect of geometry) {
    expect(rect.gap).toBeCloseTo(4, 1);
    expect(rect.bottom).toBeCloseTo(0, 1);
    expect(rect.inset).toBeCloseTo(16, 1);
    expect(rect.width).toBeCloseTo(80, 1);
    expect(rect.height).toBeCloseTo(44, 1);
    expect(rect.right).toBeCloseTo(textRight, 1);
  }
});
