import { expect, test, type Page } from '@playwright/test';

// A chat's Artifacts tab follows the Memory tab: the same centered empty state, and with
// artifacts, New document and Add file in one row whose first icon sits on the list's edge.

test.use({ viewport: { width: 1100, height: 700 } });

async function emptyState(page: Page, url: string, selector: string) {
  await page.goto(url);
  const block = page.locator(selector);
  await expect(block).toBeVisible();
  // Memory shows its button once the settings load; measure the finished block.
  await expect(block.getByRole('button').first()).toBeVisible();
  const label = block.locator('p');
  return {
    box: await block.boundingBox(),
    label: await label.evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color };
    }),
    labelBox: await label.boundingBox(),
    iconBox: await block.locator('svg').first().boundingBox(),
  };
}

for (const theme of ['light', 'dark'] as const) {
  test(`chat artifacts tab without artifacts matches the Memory tab (${theme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    const memory = await emptyState(page, `/tests/visual/chatArtifacts.html?empty=1&tab=memory&theme=${theme}`, '[data-memory-empty]');
    const artifacts = await emptyState(page, `/tests/visual/chatArtifacts.html?empty=1&theme=${theme}`, '[data-chat-artifacts-empty]');

    const empty = page.locator('[data-chat-artifacts-empty]');
    await expect(empty.getByText('No artifacts yet', { exact: true })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'New document' })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'Add file' })).toHaveAttribute('title', 'Markdown and HTML documents');
    // No section heading or helper line above the empty state.
    await expect(page.locator('.app-detail-kicker')).toHaveCount(0);

    for (const key of ['x', 'y', 'width'] as const) {
      expect(Math.abs((artifacts.box?.[key] ?? 0) - (memory.box?.[key] ?? 1))).toBeLessThan(1);
      expect(Math.abs((artifacts.iconBox?.[key] ?? 0) - (memory.iconBox?.[key] ?? 1))).toBeLessThan(1);
    }
    expect(Math.abs((artifacts.labelBox?.y ?? 0) - (memory.labelBox?.y ?? 1))).toBeLessThan(1);
    expect(artifacts.label).toEqual(memory.label);
    await expect(page).toHaveScreenshot(`chatArtifacts-empty-${theme}.png`);
  });
}

test('chat artifacts tab with artifacts lines up with its list (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/chatArtifacts.html?tab=memory&theme=light');
  const memoryTextEdge = (await page.locator('[data-memory-lesson]').first().boundingBox())?.x ?? -1;

  await page.goto('/tests/visual/chatArtifacts.html?theme=light');
  await expect(page.locator('[data-artifact-file-row="true"]')).toHaveCount(3);
  const entries = page.locator('[data-chat-document-entries="true"]');
  await expect(entries.getByRole('button', { name: 'New document' })).toBeVisible();
  await expect(page.getByText('Markdown and HTML documents', { exact: true })).toHaveClass(/\bsr-only\b/);

  // The first icon, the section heading, and the rows' file marks share the Memory tab's text edge.
  const iconX = (await entries.locator('svg').first().boundingBox())?.x ?? 0;
  const headingX = (await page.locator('.app-detail-kicker').first().boundingBox())?.x ?? 0;
  const badgeX = (await page.locator('[data-artifact-file-row="true"] span[title]').first().boundingBox())?.x ?? 0;
  for (const x of [iconX, headingX, badgeX]) expect(Math.abs(x - memoryTextEdge)).toBeLessThan(1);

  // Without a preview under it, the list is not cut short.
  await expect(page.locator('[data-artifact-file-row="true"]').last()).toBeInViewport();
  await expect(page).toHaveScreenshot('chatArtifacts-list-light.png');
});
