import { expect, test } from '@playwright/test';

const fixture = '/tests/visual/messageLayout.html';
const source = '#app-transcript-message-layout-source';
const quote = '#app-transcript-message-layout-quote';

test('Threads keeps quote navigation and discussion actions separate, and preserves message actions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator('.app-thread-message-row')).toHaveCount(8);
  for (const id of ['layout-live-quote', 'layout-streaming']) {
    const agent = page.locator(`#app-transcript-message-${id}`);
    await expect(agent.locator('.app-source-message-quote')).toHaveCount(1);
    const reference = await agent.locator('.app-thread-quote-row').boundingBox();
    const author = await agent.locator('.app-thread-message-header').boundingBox();
    expect(reference!.y + reference!.height).toBeLessThanOrEqual(author!.y);
  }
  const quoted = page.locator(quote);
  const context = await quoted.locator('.app-thread-quote-row').boundingBox();
  const header = await quoted.locator('.app-thread-message-header').boundingBox();
  expect(context!.y + context!.height).toBeLessThanOrEqual(header!.y);
  await quoted.locator('.app-source-message-quote').click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'navigate:layout-source');
  await expect(page.locator('.app-transcript-message-highlight')).toHaveCount(1);
  await page.locator(source).getByRole('button', { name: /jump to latest reply/ }).click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'navigate:layout-quote');
  await page.locator(source).getByRole('button', { name: /Open discussion with 6/ }).click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'discussion:layout-source');

  for (const [label, event] of [['Quote', 'quote'], ['Open discussion', 'discussion'], ['Forward', 'forward'], ['Pin', 'pin'], ['Select', 'select']]) {
    await page.locator(source).click({ button: 'right' });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.locator('output')).toHaveAttribute('data-last-action', `${event}:layout-source`);
  }
  await expect(page.locator(source)).toHaveClass(/app-message-selection-selected/);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.app-thread-message-row')).toHaveCount(0);
  await expect(page.locator(source)).toHaveClass(/app-message-selection-selected/);
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(source).getByRole('button', { name: /reaction, 1 people/ }).click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'react:layout-source:👍');
  await page.locator('#app-transcript-message-layout-failed').getByRole('button', { name: /Retry/i }).click();
  await expect(page.locator('output')).toHaveAttribute('data-last-action', 'retry:layout-failed');
  for (const [label, event] of [['Edit', 'edit'], ['Delete', 'delete']]) {
    await page.locator(quote).click({ button: 'right' });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.locator('output')).toHaveAttribute('data-last-action', `${event}:layout-quote`);
  }
  expect(errors).toEqual([]);
});

test('message layout persists, synchronizes across windows, and fits narrow and dark views', async ({ page, context }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Threads', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const companion = await context.newPage();
  await companion.goto(fixture);
  await expect(companion.locator('.app-thread-message-row')).toHaveCount(8);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(companion.locator('.app-thread-message-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.goto(`${fixture}?theme=${theme}`);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.locator('.app-thread-message-row')).toHaveCount(8);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const surface = page.locator(`${quote} .app-thread-message-surface`);
      expect(await surface.evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px');
      expect(await surface.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    }
  }
});
