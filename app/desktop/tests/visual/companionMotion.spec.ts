import { expect, test } from '@playwright/test';

for (const side of ['left', 'right']) {
  test(`resizing the ${side} companion keeps its full content inside its track`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 996, height: 800 });
    await page.goto('/tests/visual/companionMotion.html');
    if (side === 'left') await page.getByRole('button', { name: 'Move panel' }).click();
    const divider = page.getByRole('separator', { name: 'Resize side-by-side chats' });
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      await divider.focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press(key);
      const widths = await page.evaluate(() => {
        const width = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width;
        return { main: width('.app-chat-main-workspace'), panel: width('.app-companion-panel-motion'), content: width('.app-companion-panel-surface') };
      });
      expect(widths.main).toBeGreaterThanOrEqual(279);
      expect(widths.panel).toBeGreaterThanOrEqual(279);
      expect(Math.abs(widths.panel - widths.content)).toBeLessThan(1);
    }
  });
}

test('both panels push the workspace continuously and rapid toggles retain drafts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/tests/visual/companionMotion.html');
  await page.getByRole('textbox', { name: 'Agent draft' }).fill('Keep this draft');
  for (const [label, selector] of [['Hide sidebar', '.app-workspace-sidebar'], ['Show sidebar', '.app-workspace-sidebar'], ['Chat', '.app-companion-panel-motion'], ['Chat', '.app-companion-panel-motion']]) {
    const widths = await page.evaluate(async ({ label, selector }) => {
      const width = () => document.querySelector(selector)!.getBoundingClientRect().width;
      const samples = [width()];
      document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
      const start = performance.now();
      while (performance.now() - start < 360) { await new Promise(requestAnimationFrame); samples.push(width()); }
      return samples;
    }, { label, selector });
    const low = Math.min(widths[0], widths.at(-1)!);
    const high = Math.max(widths[0], widths.at(-1)!);
    expect(high - low).toBeGreaterThan(150);
    expect(widths.some(width => width > low + 2 && width < high - 2)).toBe(true);
  }
  await page.evaluate(async () => {
    const chat = document.querySelector<HTMLButtonElement>('button[aria-label="Chat"]')!;
    chat.click();
    await new Promise(resolve => setTimeout(resolve, 60));
    chat.click();
  });
  await expect(page.getByRole('textbox', { name: 'Agent draft' })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Chat', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
