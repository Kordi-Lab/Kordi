import { expect, test, type Locator } from '@playwright/test';

const box = async (locator: Locator) => (await locator.boundingBox())!;

for (const theme of ['light', 'dark']) {
  test(`a discussion opens as the side panel's Discussion tab and its messages match the transcript (${theme})`, async ({ page }, testInfo) => {
    await page.goto(`/tests/visual/discussionPanel.html?theme=${theme}`);
    await page.locator('.app-message-reply-line').first().click();
    const panel = page.getByRole('complementary', { name: 'Message discussion' });
    await expect(panel).toBeVisible();
    const tab = page.getByRole('tab', { name: 'Discussion', exact: true });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const toolbar = page.getByRole('group', { name: 'Companion panel' });
    await expect(toolbar.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // The tab strip owns the title, close control and width: no second column chrome.
    await expect(panel.locator('header')).toHaveCount(0);
    await expect(panel.getByRole('separator')).toHaveCount(0);
    const surface = await box(page.locator('.app-companion-panel-surface'));
    const panelBox = await box(panel);
    expect(Math.abs(panelBox.width - surface.width)).toBeLessThanOrEqual(1);
    const main = await box(page.locator('.app-chat-pane-transcript-scroll').first());
    expect(panelBox.x).toBeGreaterThanOrEqual(main.x + main.width - 1);

    // The same message keeps its gutter, avatar and bubble insets in both places.
    const geometry = (scroll: Locator) => scroll.locator('#app-transcript-message-synthetic-discussion-root').evaluate(row => {
      const scrollBox = row.closest('.app-chat-pane-transcript-scroll')!.getBoundingClientRect();
      const avatar = row.querySelector('span.rounded-\\[17\\%\\]')!.getBoundingClientRect();
      const bubble = row.querySelector('.app-message-hover-time-trigger')!;
      const bubbleBox = bubble.getBoundingClientRect();
      return { gutter: scrollBox.right - avatar.right, avatar: avatar.width, gap: avatar.left - bubbleBox.right, padding: getComputedStyle(bubble).padding, fontSize: getComputedStyle(bubble).fontSize };
    });
    expect(await geometry(panel.locator('.app-chat-pane-transcript-scroll'))).toEqual(await geometry(page.locator('.app-chat-pane-transcript-scroll').first()));
    await expect(panel.getByRole('textbox', { name: 'Add to discussion' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`discussion-tab-${theme}.png`) });

    // Another tab hides the discussion; the toolbar's Chat button brings it back.
    await toolbar.getByRole('button', { name: 'Digest', exact: true }).click();
    await expect(panel).toBeHidden();
    await toolbar.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();

    // Closing the tab closes the discussion.
    await page.getByRole('button', { name: 'Close Discussion', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Discussion', exact: true })).toHaveCount(0);
  });
}
