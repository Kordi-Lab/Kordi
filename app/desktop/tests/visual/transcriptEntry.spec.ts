import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });

test('initial load, cold hydration, and session entry reveal only a stable measured tail', async ({ page }) => {
  await page.addInitScript(() => {
    const samples: Array<{ id: string; top: number; tailGap: number }> = [];
    Object.assign(window, { transcriptEntrySamples: samples });
    const sample = () => {
      const content = document.querySelector<HTMLElement>('[data-virtual-transcript-size]');
      const viewport = document.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
      if (content && viewport && Number(getComputedStyle(content).opacity) > 0) {
        const lastRow = content.lastElementChild;
        const message = lastRow?.querySelector<HTMLElement>('[data-message-id]');
        if (message) samples.push({
          id: message.dataset.messageId!, top: message.getBoundingClientRect().top,
          tailGap: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/tests/visual/transcriptEntry.html');
  const assertStableEntry = async (key: string) => {
    const samples = await page.evaluate(async (session) => {
      const samples = (window as unknown as { transcriptEntrySamples: Array<{ id: string; top: number; tailGap: number }> }).transcriptEntrySamples;
      // Include the settling frames after the first visible paint, not only the
      // final geometry that an ordinary visibility assertion would inspect.
      for (let frame = 0; frame < 35; frame += 1) await new Promise(requestAnimationFrame);
      return samples.filter(sample => sample.id.startsWith(`${session}-`));
    }, key);
    expect(samples.length).toBeGreaterThan(5);
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
});
