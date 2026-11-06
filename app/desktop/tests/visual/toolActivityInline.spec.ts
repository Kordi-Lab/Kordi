import { expect, test, type Locator, type Page } from '@playwright/test';

async function waitForDisclosureLayout(page: Page) {
  const body = page.locator('.app-ordered-progress > .app-progress-disclosure');
  await expect.poll(() => body.evaluate(element => {
    const height = element.getBoundingClientRect().height;
    return height > 0 && Math.abs(height - element.firstElementChild!.getBoundingClientRect().height) < 1;
  })).toBe(true);
}

async function expectConversationScrollingOnly(page: Page) {
  await expect(page.locator('[data-transcript-disclosure-constrained="true"]')).toHaveCount(0);
  const overflow = await page.locator('.app-ordered-progress').evaluate(root => [...root.querySelectorAll<HTMLElement>('*')].filter(element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && (
      (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1)
      || element.scrollTop !== 0
      // A one-line tool summary truncates on purpose; everything else must wrap.
      || (element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== 'ellipsis')
    );
  }).map(element => element.className));
  expect(overflow).toEqual([]);
}

async function toggleWithoutJump(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  const element = await control.elementHandle();
  const measure = () => element!.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-virtual-transcript-scroll]')!;
    return { top: element.getBoundingClientRect().top, scroll: viewport.scrollTop, max: viewport.scrollHeight - viewport.clientHeight };
  });
  const before = await measure();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  expect(await element!.evaluate(element => element.isConnected)).toBe(true);
  const after = await measure();
  expect(Math.abs(after.top - before.top), JSON.stringify({ before, after })).toBeLessThan(2);
}

for (const zoom of [1, 1.5, 2]) {
  test(`inline activity keeps one scroll owner at ${zoom}x zoom`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1040 });
    await page.goto('/tests/visual/processingTrajectory.html?count=50&phase=9&toolActivity=empty');
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
    const worked = page.locator('.app-turn-worked-header');
    await expect(worked).toBeVisible();
    await toggleWithoutJump(page, worked);
    await expect(page.locator('.app-tool-activity')).toHaveCount(1);
    await expect(page.locator('.app-turn-progress-summary')).toHaveCount(0);
    await expect(page.locator('.app-tool-activity-label')).toContainText('Searched conversations');
    await expect(page.locator('.app-tool-activity-label')).toContainText('Project notes');
    const row = page.locator('.app-tool-activity-toggle');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('Tool output', { exact: true })).toHaveCount(0);
    await toggleWithoutJump(page, row);
    await expect(page.getByLabel('Tool output', { exact: true })).toHaveText('No matching sessions found.');
    const input = page.locator('.app-tool-input-details > button');
    await toggleWithoutJump(page, input);
    await expect(page.getByLabel('Tool input', { exact: true })).toContainText('"query":"Project notes"');
    await expectConversationScrollingOnly(page);
    await toggleWithoutJump(page, input);
    await expect(page.getByLabel('Tool input', { exact: true })).toBeHidden();
    await expectConversationScrollingOnly(page);
  });
}

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`long output and input expand in the transcript with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/tests/visual/processingTrajectory.html?count=50&phase=9&toolActivity=long');
    await page.locator('.app-turn-worked-header').click();
    await waitForDisclosureLayout(page);
    await toggleWithoutJump(page, page.locator('.app-tool-activity-toggle'));
    const output = page.getByLabel('Tool output', { exact: true });
    await expect(output).not.toContainText('Synthetic result 60:');
    const more = page.getByRole('button', { name: 'Show all tool output', exact: true });
    await toggleWithoutJump(page, more);
    await expect(output).toContainText('Synthetic result 60:');
    await expectConversationScrollingOnly(page);
    await toggleWithoutJump(page, page.getByRole('button', { name: 'Show less tool output', exact: true }));
    await expect(output).not.toContainText('Synthetic result 60:');
    const input = page.locator('.app-tool-input-details > button');
    await toggleWithoutJump(page, input);
    await toggleWithoutJump(page, page.getByRole('button', { name: 'Show all tool input', exact: true }));
    await expect(page.getByLabel('Tool input', { exact: true })).toContainText('"limit":8}');
    await page.setViewportSize({ width: 760, height: 720 });
    await expectConversationScrollingOnly(page);
  });
}

test('running and failed searches preserve their status in the inline row', async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=6&toolActivity=empty');
  await page.locator('.app-turn-worked-header').click();
  await expect(page.locator('.app-tool-activity-label')).toContainText('Searching conversations');
  await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=9&toolActivity=failed');
  await page.locator('.app-turn-worked-header').click();
  await expect(page.locator('.app-tool-activity-error')).toHaveText('Failed');
  await expect(page.getByLabel('Tool output', { exact: true })).toHaveCount(0);
  await page.locator('.app-tool-activity-toggle').click();
  await expect(page.getByLabel('Tool output', { exact: true })).toContainText('unavailable');
});

test('a single inline tool stays visible when streaming adds a second tool to its group', async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=6&toolActivity=multiple');
  await page.locator('.app-turn-worked-header').click();
  await expect(page.locator('.app-tool-activity')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory.step(9));
  await expect(page.locator('.app-tool-activity')).toHaveCount(2);
  await expect(page.locator('.app-turn-progress-summary')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.app-tool-activity-toggle[aria-expanded="false"]')).toHaveCount(2);
  await expect(page.getByText('Synthetic conversation context.', { exact: true })).toHaveCount(0);
  await page.locator('.app-tool-activity-toggle').nth(1).click();
  await expect(page.getByText('Synthetic conversation context.', { exact: true })).toBeVisible();
  await expectConversationScrollingOnly(page);
});

const AFTER_SCREENSHOTS = process.env.KORDI_TURN_FOLD_SCREENSHOTS;

test('a finished turn folds every work detail and hides the web security notice', async ({ page }, info) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=9&toolActivity=fetch');
  const shot = (name: string) => page.screenshot({ path: AFTER_SCREENSHOTS ? `${AFTER_SCREENSHOTS}/${name}` : info.outputPath(name), fullPage: true });
  const worked = page.locator('.app-turn-worked-header');
  await expect(worked).toHaveAttribute('aria-label', 'Worked for 12s');
  await expect(worked).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.app-tool-activity:visible')).toHaveCount(0);
  await expect(page.getByText(/SECURITY NOTICE|Fetching:/)).toHaveCount(0);
  await shot('1-finished-turn-collapsed.png');

  await toggleWithoutJump(page, worked);
  const rows = page.locator('.app-tool-activity-toggle');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Fetch web page · example.com');
  await expect(rows.nth(1)).toContainText('ls src');
  for (const row of await rows.all()) await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel(/^(Tool|Shell) output$/)).toHaveCount(0);
  await expect(page.locator('.app-tool-input-details')).toHaveCount(0);
  for (const row of await rows.all()) expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(30);
  await shot('2-expanded-tool-rows-collapsed.png');

  await toggleWithoutJump(page, rows.nth(0));
  const output = page.getByLabel('Tool output', { exact: true });
  await expect(output).toContainText('Source: Web Fetch');
  await expect(output).not.toContainText('SECURITY NOTICE');
  await toggleWithoutJump(page, page.getByRole('button', { name: 'Show all tool output', exact: true }));
  await expect(output).toContainText('Synthetic page body.');
  await expect(output).not.toContainText('SECURITY NOTICE');
  await expect(output).not.toContainText('When summarizing this page');
  await expect(page.getByLabel('Shell output', { exact: true })).toHaveCount(0);
  await expect(page.locator('.app-tool-input-details > button')).toHaveText('View input');
  await expectConversationScrollingOnly(page);
  await shot('3-fetch-row-expanded.png');

  await worked.click();
  await expect(worked).toHaveAttribute('aria-expanded', 'false');
  await worked.click();
  await expect(worked).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
});

test('a running turn with fetched output stays one line without raw output', async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=2&phase=6&toolActivity=fetch');
  const worked = page.locator('.app-turn-worked-header');
  await expect(worked).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(/SECURITY NOTICE|Fetching:|Synthetic page body/)).toHaveCount(0);
  await worked.click();
  await expect(page.locator('.app-tool-activity-toggle[aria-expanded="false"]')).toHaveCount(2);
  await expect(page.getByText(/SECURITY NOTICE|Fetching:|Synthetic page body/)).toHaveCount(0);
});
