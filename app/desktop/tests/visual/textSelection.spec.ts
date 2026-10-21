import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragText(page: Page, content: Locator, start: number, end: number) {
  await page.evaluate(() => document.fonts.ready);
  await content.click({ trial: true });
  const points = await content.evaluate((element, offsets) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number) => {
      for (const node of nodes) {
        if (offset < node.length) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 0.5, y: rect.top + rect.height / 2 };
        }
        offset -= node.length;
      }
      throw new Error('Selection offset outside text');
    };
    return { start: point(offsets.start), end: point(offsets.end), expected: element.textContent!.slice(offsets.start, offsets.end) };
  }, { start, end });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 24 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(points.expected);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/visual/textSelectionPreview.html');
  await expect(page.getByRole('heading', { name: 'Text selection review' })).toBeVisible();
});

test('partial words and wrapped ranges retain exact visible selection endpoints', async ({ page }) => {
  const surface = page.locator('[data-kordi-copy-surface="message"]').first();
  const firstParagraph = surface.locator('p').first();
  await dragText(page, firstParagraph, 3, 6);
  const paragraph = surface.locator('p').nth(1);
  await dragText(page, paragraph, 12, 195);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection()!;
    return new Set(Array.from(selection.getRangeAt(0).getClientRects()).map(rect => Math.round(rect.top))).size;
  })).toBeGreaterThan(1);
  await expect(surface).not.toHaveAttribute('data-kordi-copy-selection', 'unified');
  expect(await surface.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
  expect(await firstParagraph.evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('double click selects a word', async ({ page }) => {
  const paragraph = page.locator('[data-kordi-copy-surface="message"]').first().locator('p').first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.dblclick({ position: { x: 15, y: 10 } });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe('Welcome');
});

test('keyboard copy preserves a partial range', async ({ page }) => {
  const paragraph = page.locator('[data-kordi-copy-surface="message"]').first().locator('p').first();
  await dragText(page, paragraph, 3, 6);
  // Exercise the browser copy command, then paste into the review field.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.getByLabel('Paste here to check the exact text you copied').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(page.getByLabel('Paste here to check the exact text you copied')).toHaveValue('com');
});

test('dark appearance retains precise selection in formatted text', async ({ page }) => {
  await page.getByRole('button', { name: 'Dark appearance' }).click();
  const surface = page.locator('[data-kordi-copy-surface="message"]').last();
  const paragraph = surface.locator('p').first();
  await paragraph.scrollIntoViewIfNeeded();
  await dragText(page, paragraph, 4, 34);
  await expect(surface).not.toHaveAttribute('data-kordi-copy-selection', 'unified');
});
