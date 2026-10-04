import { expect, test, type Page } from '@playwright/test';

async function geometry(page: Page) {
  return page.locator('[data-composer-model-controls] > button, [data-neighbor]').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    const icon = element.querySelector('svg')?.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, iconX: icon?.x };
  }));
}

for (const scenario of [
  { name: 'desktop', width: 1100, compact: false },
  { name: 'compact', width: 500, compact: true },
  { name: 'narrow', width: 360, compact: true },
]) {
  test(`${scenario.name}: selectors stay equal and stationary across route changes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 700 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/tests/visual/composerModelControls.html${scenario.compact ? '?compact' : ''}`);
    const triggers = page.locator('[data-composer-model-controls] > button');
    await expect(triggers).toHaveCount(3);
    const initial = await geometry(page);
    for (const rect of initial.slice(0, 3)) expect(rect.width).toBeCloseTo(initial[0].width, 1);
    expect(initial.at(-1)!.x + initial.at(-1)!.width).toBeLessThanOrEqual(scenario.width);
    for (const change of [
      { index: 1, label: 'A much longer model display name' },
      { index: 1, label: 'gpt-5.6-sol' },
      { index: 2, label: 'Extra High' },
      { index: 0, label: 'Claude' },
      { index: 0, label: 'ChatGPT' },
    ]) {
      await triggers.nth(change.index).click();
      await page.locator('.app-composer-model-menu-layer').getByRole('button', { name: change.label, exact: false }).click();
      await expect(page.locator('.app-composer-model-menu-layer')).toHaveCount(0);
      await expect.poll(() => geometry(page)).toEqual(initial);
      // Check the rendered frames as well as the final position: label changes
      // must not resize controls or move the neighboring project selector.
      const frames = await page.evaluate(async () => {
        const samples = [];
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise(requestAnimationFrame);
          samples.push(Array.from(document.querySelectorAll('[data-composer-model-controls] > button, [data-neighbor]'), element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          }));
        }
        return samples;
      });
      for (const frame of frames) expect(frame).toEqual(initial.map(({ iconX: _iconX, ...rect }) => rect));
    }
    await page.screenshot({ path: testInfo.outputPath(`composer-${scenario.name}.png`) });
  });
}
