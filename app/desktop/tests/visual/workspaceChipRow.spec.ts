import { expect, test } from '@playwright/test';

const widths = [360, 480, 640, 900];
const cases = ['chat-short', 'chat-long'];

for (const theme of ['light', 'dark']) {
  test(`${theme}: workspace chips stay on one line at every pane width`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 1100 });
    await page.goto(`/tests/visual/workspaceChipRow.html?theme=${theme}`);
    await expect(page.getByRole('button', { name: 'Select branch or worktree' })).toHaveCount(widths.length * cases.length);
    await expect(page.getByRole('checkbox', { name: 'Use worktree' })).toHaveCount(widths.length * cases.length);
    for (const width of widths) {
      for (const id of cases) {
        const row = page.getByTestId(`row-${width}-${id}`).locator('.chat-workspace-selector-row');
        const layout = await row.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const chips = Array.from(element.children).map((child) => {
            const rect = child.getBoundingClientRect();
            return { className: child.className, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
          });
          const label = element.querySelector('.chat-workspace-git label')!.getBoundingClientRect().width;
          return { left: box.left, right: box.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, chips, label };
        });
        const where = `${theme} ${width}px ${id}`;
        expect(layout.chips.length, where).toBe(4);
        expect(new Set(layout.chips.map((chip) => chip.top)).size, `${where}: one row`).toBe(1);
        expect(layout.scrollWidth, `${where}: no overflow`).toBeLessThanOrEqual(layout.clientWidth);
        for (const chip of layout.chips) {
          expect(chip.left, `${where}: ${chip.className}`).toBeGreaterThanOrEqual(layout.left - 0.5);
          expect(chip.right, `${where}: ${chip.className}`).toBeLessThanOrEqual(layout.right + 0.5);
          expect(chip.bottom - chip.top, `${where}: ${chip.className} height`).toBeCloseTo(26, 0);
        }
        const [location, , , add] = layout.chips;
        expect(add.className, where).toContain('chat-workspace-add');
        expect(location.width < 34, `${where}: location collapsed`).toBe(width === 360);
        expect(layout.label < 34, `${where}: worktree collapsed`).toBe(width === 360);
      }
    }
    const branch = page.getByTestId('row-360-chat-short').getByRole('button', { name: 'Select branch or worktree' });
    await expect(branch).toHaveAttribute('title', 'design/sample-feature-with-a-long-branch-name');
    // Collapsed chips keep their text for assistive technology.
    const narrow = await page.getByTestId('row-360-chat-short').ariaSnapshot();
    expect(narrow).toContain('Local');
    expect(narrow).toContain('Use worktree');
    await page.screenshot({ path: testInfo.outputPath(`workspace-chip-row-${theme}.png`), fullPage: true });
  });
}
