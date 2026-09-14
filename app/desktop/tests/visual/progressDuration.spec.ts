import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

for (const token of ['260ms', '.26s']) test(`progress preserves the duration of ${token}`, async ({ page }) => {
  await page.goto('/tests/visual/processingTrajectory.html?count=50');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  await page.addStyleTag({ content: `:root, .theme-light { --app-motion-base: ${token} !important; }` });
  const duration = await page.evaluate(async () => {
    const driver = (window as unknown as { processingTrajectory: { step(phase: number): void } }).processingTrajectory;
    driver.step(1);
    await new Promise(resolve => setTimeout(resolve, 220));
    const element = document.querySelector<HTMLElement>('[data-index="49"]')!;
    let captured = 0;
    const animate = element.animate.bind(element);
    element.animate = (frames, options) => {
      if (typeof options === 'object') captured = Number(options.duration);
      return animate(frames, options);
    };
    driver.step(3);
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    return captured;
  });
  expect(duration).toBe(260);
});
