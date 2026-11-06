import { expect, test, type Locator } from '@playwright/test';

const box = async (locator: Locator) => (await locator.boundingBox())!;

for (const theme of ['light', 'dark']) {
  test(`discussion header lines up with the tab row and its messages match the transcript (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/discussionPanel.html?theme=${theme}`);
    await page.locator('.app-message-reply-line').first().click();
    const panel = page.getByRole('complementary', { name: 'Message discussion' });
    await expect(panel).toBeVisible();

    const tabsHeader = page.locator('.app-chat-pane-header:has(.app-chat-destination-tabs)');
    const header = panel.locator('header');
    const [main, side] = [await box(tabsHeader), await box(header)];
    expect(Math.abs(side.y + side.height - (main.y + main.height))).toBeLessThanOrEqual(1);
    expect(Math.abs(side.height - main.height)).toBeLessThanOrEqual(1);

    const title = header.getByRole('heading', { name: 'Discussion' });
    await expect(title).toHaveCSS('font-size', '13px');
    await expect(title).toHaveCSS('font-weight', '500');
    await expect(header).not.toContainText(/message/i);
    const close = await box(header.getByRole('button', { name: 'Close discussion' }));
    const titleBox = await box(title);
    expect(Math.abs(close.y + close.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThanOrEqual(1);

    // The same message keeps its gutter, avatar and bubble insets in both places.
    const geometry = (scroll: Locator) => scroll.locator('#app-transcript-message-synthetic-discussion-root').evaluate(row => {
      const scrollBox = row.closest('.app-chat-pane-transcript-scroll')!.getBoundingClientRect();
      const avatar = row.querySelector('span.rounded-\\[17\\%\\]')!.getBoundingClientRect();
      const bubble = row.querySelector('.app-message-hover-time-trigger')!;
      const bubbleBox = bubble.getBoundingClientRect();
      return { gutter: scrollBox.right - avatar.right, avatar: avatar.width, gap: avatar.left - bubbleBox.right, padding: getComputedStyle(bubble).padding, fontSize: getComputedStyle(bubble).fontSize };
    });
    expect(await geometry(panel.locator('.app-chat-pane-transcript-scroll'))).toEqual(await geometry(page.locator('.app-chat-pane-transcript-scroll').first()));
  });
}
