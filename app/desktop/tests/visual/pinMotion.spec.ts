import { expect, test } from '@playwright/test';

test('pin shelf pushes in and out continuously and can reverse before settling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/tests/visual/processingTrajectory.html?pin-motion');
  const shelf = page.locator('.app-pin-shelf');
  await expect(shelf).toHaveAttribute('data-open', 'false');
  await page.getByRole('button', { name: 'Toggle pin' }).click();
  const heights = await shelf.evaluate(async element => {
    const frames: number[] = []; const start = performance.now();
    await new Promise<void>(resolve => {
      const tick = () => { frames.push(element.getBoundingClientRect().height); if (performance.now() - start < 350) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    return frames;
  });
  expect(heights.at(-1)).toBeGreaterThan(40);
  expect(heights.some(height => height > 1 && height < heights.at(-1)! - 1)).toBe(true);
  await page.getByRole('button', { name: 'Toggle pin' }).click();
  await expect(shelf).toHaveAttribute('inert', '');
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: 'Toggle pin' }).click();
  await expect(shelf).toHaveAttribute('data-open', 'true');
  await page.waitForTimeout(300);
  expect(await shelf.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(heights.at(-1)!, 0);
  await page.getByRole('button', { name: 'Toggle pin' }).click();
  await page.waitForTimeout(300);
  expect(await shelf.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
});

test('existing pin opens without replay and reduced motion removes the push', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/visual/processingTrajectory.html?pin-motion&pinned');
  const shelf = page.locator('.app-pin-shelf');
  await expect(shelf).toHaveAttribute('data-open', 'true');
  expect(await shelf.evaluate(element => element.getAnimations().length)).toBe(0);
  await page.getByRole('button', { name: 'Toggle pin' }).click();
  expect(await shelf.evaluate(element => getComputedStyle(element).transform)).toBe('none');
  expect(await page.locator('[data-pin-activity]').evaluate(element => element.getAnimations().every(animation =>
    (animation.effect as KeyframeEffect).getKeyframes().every(frame => !frame.transform)))).toBe(true);
});
