import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

test('initial load, cold hydration, and session entry reveal only a stable measured tail', async ({ page }) => {
  await page.addInitScript(() => {
    const samples: Array<{ id: string; top: number; tailGap: number; historyAnimations: number }> = [];
    Object.assign(window, { transcriptEntrySamples: samples });
    const sample = () => {
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]');
      const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
      if (content && viewport && getComputedStyle(content).visibility !== 'hidden') {
        const lastRow = content.lastElementChild;
        const message = lastRow?.querySelector<HTMLElement>('[data-message-id]');
        if (message) samples.push({
          id: message.dataset.messageId!, top: message.getBoundingClientRect().top,
          tailGap: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
          historyAnimations: content.getAnimations().length,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/tests/visual/transcriptEntry.html');
  const assertStableEntry = async (key: string) => {
    const samples = await page.evaluate(async (session) => {
      const samples = (window as unknown as { transcriptEntrySamples: Array<{ id: string; top: number; tailGap: number; historyAnimations: number }> }).transcriptEntrySamples;
      // Include the settling frames after the first visible paint, not only the
      // final geometry that an ordinary visibility assertion would inspect.
      for (let frame = 0; frame < 35; frame += 1) await new Promise(requestAnimationFrame);
      return samples.filter(sample => sample.id.startsWith(`${session}-`));
    }, key);
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.every(sample => sample.historyAnimations === 0), 'session history must not fade or slide on entry').toBe(true);
    expect(samples.every(sample => sample.id === `${key}-199`)).toBe(true);
    expect(Math.max(...samples.map(sample => Math.abs(sample.tailGap)))).toBeLessThanOrEqual(1);
    const tops = samples.map(sample => sample.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  };
  await assertStableEntry('first');
  await page.getByRole('button', { name: 'Cold session' }).click();
  await expect(page.getByText('Loading synthetic messages')).toBeVisible();
  await assertStableEntry('cold');
  await page.getByRole('button', { name: 'Next session' }).click();
  await assertStableEntry('next');
  await page.getByRole('button', { name: 'First session' }).click();
  await assertStableEntry('first');
  await page.getByRole('button', { name: 'Catalog-only session' }).click();
  await expect(page.locator('[data-transcript-initial-loading]')).toBeVisible();
  // A slow first page must not reveal the lone catalog head after the virtual
  // list's bounded layout-settling window has elapsed.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 35; frame += 1) await new Promise(requestAnimationFrame);
  });
  await expect(page.locator('[data-message-id="catalog-199"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish catalog hydration' }).click();
  await assertStableEntry('catalog');
});

test('an image above the tail can finish after reveal without moving the final text row', async ({ page }) => {
  await page.goto('/tests/visual/transcriptEntry.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const positions = await page.evaluate(async () => {
    const final = document.querySelector<HTMLElement>('[data-message-id="first-199"]')!;
    const positions = [final.getBoundingClientRect().top];
    const record = async () => {
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise(requestAnimationFrame);
        positions.push(final.getBoundingClientRect().top);
      }
    };
    const recording = record();
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Finish late image')!.click();
    await recording;
    return positions;
  });
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
});

test('a decoded attachment preserves the tail after its placeholder was already visible', async ({ page }) => {
  let finishImage!: () => void;
  const imageReady = new Promise<void>(resolve => { finishImage = resolve; });
  await page.route('**/synthetic-portrait.svg', async route => {
    await imageReady;
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="260"><rect width="120" height="260" fill="#8aa"/></svg>' });
  });
  await page.goto('/tests/visual/transcriptEntry.html?media=1');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const recording = page.evaluate(async () => {
    const final = document.querySelector<HTMLElement>('[data-message-id="first-199"]')!;
    const positions = [final.getBoundingClientRect().top];
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      positions.push(final.getBoundingClientRect().top);
    }
    return positions;
  });
  finishImage();
  await expect(page.locator('[data-attachment-image-loaded="true"]')).toBeVisible();
  const positions = await recording;
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
});


test('session entry waits for both transcript edges to settle before showing history', async ({ page }) => {
  await page.goto('/tests/visual/transcriptEntry.html');
  await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
  const samples = await page.evaluate(async () => {
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Next session')!.click();
    const samples: Array<{ left: number; right: number }> = [];
    for (let frame = 0; frame < 35; frame += 1) {
      await new Promise(requestAnimationFrame);
      const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
      // Model native scrollbar/inset settling without changing message heights.
      if ([4, 7, 10, 13].includes(frame)) viewport.style.paddingInline = `${20 + ((frame - 1) / 3) * 2}px`;
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]')!;
      if (getComputedStyle(content).visibility !== 'hidden') {
        const rect = content.getBoundingClientRect();
        samples.push({ left: rect.left, right: rect.right });
      }
    }
    return samples;
  });
  expect(samples.length).toBeGreaterThan(5);
  for (const edge of ['left', 'right'] as const) {
    const positions = samples.map(sample => sample[edge]);
    expect(Math.max(...positions) - Math.min(...positions), edge).toBeLessThanOrEqual(1);
  }
});

for (const progress of [false, true]) {
  test(`late small row growth keeps the visible tail still (${progress ? 'Agent' : 'Human'})`, async ({ page }) => {
    await page.goto(`/tests/visual/transcriptEntry.html${progress ? '?progress=1' : ''}`);
    await expect(page.locator('[data-virtual-transcript-session-ready="true"]')).toBeVisible();
    const samples = await page.evaluate(async () => {
      const row = document.querySelector<HTMLElement>('[data-message-id="first-199"]')!;
      const samples = [row.getBoundingClientRect().top];
      for (let frame = 0; frame < 50; frame += 1) {
        if ([4, 14, 24, 34].includes(frame)) window.dispatchEvent(new Event('synthetic-small-growth'));
        await new Promise(requestAnimationFrame);
        samples.push(row.getBoundingClientRect().top);
      }
      return samples;
    });
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(1);
  });
}
