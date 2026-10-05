import { expect, test } from '@playwright/test';

for (const appearance of ['light', 'dark'] as const) {
  for (const layout of ['chat', 'threads'] as const) {
    test(`${layout} mentions, replies, and receipts remain readable (${appearance})`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('kordi.messageLayout.v1', value);
      }, layout);
      await page.goto('/tests/visual/groupMentionPreview.html?themeContrast');
      await page.addStyleTag({ content: '[data-contrast-components] * { transition: none !important; }' });
      await page.getByRole('combobox', { name: 'Preview appearance' }).selectOption(appearance);
      await expect(page.locator('#app-transcript-message-contrast-read')).toBeVisible();
      if (layout === 'threads') {
        await expect(page.locator('#app-transcript-message-contrast-read')).toHaveClass(/app-thread-message-row/);
      } else {
        await expect(page.locator('#app-transcript-message-contrast-read')).not.toHaveClass(/app-thread-message-row/);
      }

      for (const theme of ['default', 'quiet', 'midnight', 'sand', 'ocean']) {
        await page.getByRole('combobox', { name: 'Preview chat theme' }).selectOption(theme);
        await expect(page.locator('body')).toHaveAttribute('data-kordi-chat-theme', theme);
        const contrast = await page.locator([
          '#app-transcript-message-contrast-read .app-message-mention',
          '#app-transcript-message-contrast-peer .app-message-mention',
          '#app-transcript-message-contrast-all .app-message-mention',
          '#app-transcript-message-contrast-read .app-message-reply-count',
          '#app-transcript-message-contrast-read [data-message-delivery-glyph] > *',
          '#app-transcript-message-contrast-delivered [data-message-delivery-glyph] > *',
        ].join(',')).evaluateAll((elements) => elements.map((element) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const draw = (color: string) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
          };
          const surface = element.closest('.app-chat-bubble-user, .app-chat-bubble-peer')!;
          const ancestors: Element[] = [];
          for (let ancestor: Element | null = surface; ancestor; ancestor = ancestor.parentElement) {
            ancestors.unshift(ancestor);
          }
          // Composite translucent surfaces over their real ancestor backgrounds.
          draw('#FFFFFF');
          for (const ancestor of ancestors) draw(getComputedStyle(ancestor).backgroundColor);
          const shape = surface.querySelector('.app-message-bubble-shape-fill');
          if (shape) draw(getComputedStyle(shape).fill);
          const background = Array.from(context.getImageData(0, 0, 1, 1).data);
          context.clearRect(0, 0, 1, 1);
          draw(getComputedStyle(element).color);
          const foreground = Array.from(context.getImageData(0, 0, 1, 1).data);
          const luminance = (color: number[]) => color.slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
          const ink = luminance(foreground);
          const fill = luminance(background);
          return {
            label: element.textContent || element.parentElement?.getAttribute('data-message-delivery-glyph'),
            own: surface.classList.contains('app-chat-bubble-user'),
            ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05),
          };
        }));

        expect(contrast.length).toBeGreaterThanOrEqual(8);
        expect(contrast.some((sample) => !sample.own)).toBe(true);
        for (const sample of contrast) {
          expect(sample.ratio, `${theme}: ${sample.own ? 'outgoing' : 'incoming'} ${sample.label}`)
            .toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
}
