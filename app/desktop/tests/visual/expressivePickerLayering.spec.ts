import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`animated transcript stays behind all picker tabs (${theme})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Keep image decoding deterministic and all test data offline.
    await page.route('https://**/*', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="orange"/></svg>' }));
    await page.goto(`/tests/visual/expressivePickerLayering.html?theme=${theme}`);
    const animations = page.locator('.app-noto-animation[data-ready="true"]');
    await expect(animations.first()).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Emoji, stickers, and GIFs', exact: true });
    const picker = page.getByRole('dialog', { name: 'Emoji, stickers, and GIF picker' });
    await trigger.click();
    for (const tab of ['Stickers', 'GIFs', 'Emoji', 'Stickers']) {
      await picker.getByRole('tab', { name: tab, exact: true }).click();
      await expect(picker.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
      // Hit-test the actual overlap points, not only the picker's declared z-index.
      await expect.poll(() => animations.evaluateAll(elements => {
        const picker = document.querySelector('[data-expressive-picker]')!;
        const panel = picker.getBoundingClientRect();
        let overlap = 0;
        let obscured = 0;
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          const x = Math.max(rect.left, panel.left) + 2;
          const y = Math.max(rect.top, panel.top) + 2;
          if (x >= Math.min(rect.right, panel.right) || y >= Math.min(rect.bottom, panel.bottom)) continue;
          overlap += 1;
          if (!picker.contains(document.elementFromPoint(x, y))) obscured += 1;
        }
        return { overlap: overlap > 0, obscured };
      })).toEqual({ overlap: true, obscured: 0 });
      if (tab !== 'Emoji') {
        const search = picker.getByRole('searchbox');
        await search.fill('Sample');
        await expect(picker.getByRole('button', { name: `Send Sample ${tab === 'Stickers' ? 'sticker' : 'gif'}`, exact: true })).toBeVisible();
      }
    }
    await picker.getByRole('button', { name: 'Send Sample sticker', exact: true }).click();
    await expect(page.getByTestId('selection')).toHaveText('Sample sticker');
    await expect(picker).toBeHidden();
    await trigger.click();
    await picker.getByRole('tab', { name: 'GIFs', exact: true }).click();
    await picker.getByRole('button', { name: 'Send Sample gif', exact: true }).click();
    await expect(page.getByTestId('selection')).toHaveText('Sample gif');
    await expect(picker).toBeHidden();
    await trigger.click();
    await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
    await picker.getByRole('option').first().click();
    await expect(page.getByTestId('selection')).not.toHaveText('Sample gif');
    await expect(picker).toBeHidden();
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
