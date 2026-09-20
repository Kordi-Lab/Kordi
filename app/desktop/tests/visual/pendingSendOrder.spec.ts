import { expect, test } from '@playwright/test';

test('acknowledged bubbles stay above later pending sends when server timestamps change', async ({ page }) => {
  await page.goto('/tests/visual/pendingSendOrder.html');
  const labels = ['First message', 'Second message', 'Third message', 'Fourth message'];
  await expect(page.getByText(labels[3], { exact: true })).toBeVisible();
  for (let acknowledged = 0; acknowledged <= labels.length; acknowledged++) {
    const tops: number[] = [];
    for (const label of labels) {
      const bounds = await page.getByText(label, { exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      tops.push(bounds!.y);
    }
    expect(tops).toEqual([...tops].sort((left, right) => left - right));
    if (acknowledged < labels.length) {
      await page.getByRole('button', { name: 'Acknowledge next message' }).click();
      await expect(page.locator('[role="img"][data-message-delivery-status="delivered"]')).toHaveCount(acknowledged + 1);
      const receipt = page.locator('[role="img"][data-message-delivery-status="delivered"]').nth(acknowledged);
      await expect(receipt.locator('svg.lucide-check')).toHaveCSS('opacity', '1');
      await expect(receipt.locator('svg').nth(2)).toHaveCSS('opacity', '0');
      if (acknowledged === 0) await page.screenshot({ path: test.info().outputPath('first-acknowledged.png') });
    }
  }
});
