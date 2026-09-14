import { expect, test } from '@playwright/test';

test('owner reasoning remains visible through public progress and completion', async ({ page }) => {
  await page.goto('/tests/visual/groupReasoningVisibility.html');
  const reasoning = page.getByText(/synthetic private reasoning/i);
  await expect(reasoning).toBeVisible();
  for (const label of ['Public progress', 'Complete response']) {
    await page.getByRole('button', { name: label }).click();
    await expect(reasoning).toBeVisible();
  }
  await page.getByRole('button', { name: 'Next request' }).click();
  await expect(reasoning).toHaveCount(0);
});

test('peers never render reasoning, including a visibility change with the same turn object', async ({ page }) => {
  await page.goto('/tests/visual/groupReasoningVisibility.html?peer=1');
  await expect(page.getByText('Public reply', { exact: true })).toBeVisible();
  await expect(page.getByText(/synthetic private reasoning/i)).toHaveCount(0);
  await page.goto('/tests/visual/groupReasoningVisibility.html');
  await expect(page.getByText(/synthetic private reasoning/i)).toBeVisible();
  await page.getByRole('button', { name: 'View as peer' }).click();
  await expect(page.getByText(/synthetic private reasoning/i)).toHaveCount(0);
});
