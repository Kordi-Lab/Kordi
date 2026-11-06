import { expect, test, type Page } from '@playwright/test';

// KORDI_RUNNING_CONTROLS_SHOTS=<dir> also saves one screenshot per state for review.
const shotsDir = process.env.KORDI_RUNNING_CONTROLS_SHOTS;
async function shot(page: Page, name: string) {
  if (shotsDir) await page.locator('main').screenshot({ path: `${shotsDir}/${name}.png` });
}

for (const theme of ['light', 'dark'] as const) {
  test(`running reply controls: Stop on the status line, Fork on hover once finished (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/runningAgentControls.html?theme=${theme}`);
    const row = (label: string) => page.locator(`[data-row="${label}"]`);

    // Running: the name line holds only the name and owner; Stop follows the elapsed time.
    const running = row('Running');
    await expect(running.locator('.app-message-meta')).toHaveText('Atlas');
    await expect(running.getByText('Owner · You', { exact: true })).toBeVisible();
    const statusLine = running.locator('.app-turn-header-line');
    const stop = statusLine.locator('[data-agent-request-stop="status"]').getByRole('button', { name: 'Stop agent request' });
    await expect(stop).toHaveText('Stop');
    await expect(running.locator('.app-message-fork-button')).toBeHidden();
    // The elapsed time sits right after the label, then Stop.
    const [label, time, stopBox] = await Promise.all([
      statusLine.locator('.app-turn-status-label').boundingBox(),
      statusLine.locator('.app-turn-progress-time').boundingBox(),
      stop.boundingBox(),
    ]);
    expect(time!.x - (label!.x + label!.width)).toBeLessThanOrEqual(10);
    expect(stopBox!.x).toBeGreaterThan(time!.x + time!.width);
    await shot(page, `${theme}-1-running`);

    await stop.hover();
    await expect(stop).toHaveAttribute('title', 'Stop agent request');
    await shot(page, `${theme}-2-running-hover-stop`);

    // Stopping: the button dims to "Stopping…" and the status reads the same.
    const stoppingRow = row('Stopping');
    await stoppingRow.getByRole('button', { name: 'Stop agent request' }).click();
    await expect(page.locator('output')).toHaveAttribute('data-last-action', 'stop:stopping');
    const stopping = stoppingRow.getByRole('button', { name: 'Stopping agent request' });
    await expect(stopping).toHaveText('Stopping…');
    await expect(stopping).toBeDisabled();
    await expect(stoppingRow.locator('.app-turn-status-text')).toHaveText('Stopping…');
    await page.mouse.move(0, 0);
    await shot(page, `${theme}-3-stopping`);

    // Stopped: no Stop, "Stopped" with the elapsed time.
    const stopped = row('Stopped');
    await expect(stopped.locator('[data-agent-request-stop]')).toHaveCount(0);
    await expect(stopped.locator('.app-turn-status-text')).toHaveText('Stopped');
    await expect(stopped.locator('.app-turn-progress-time')).toHaveText(/^\d+s$/);
    await shot(page, `${theme}-4-stopped`);

    // Finished: Fork shows beside the name while the pointer is over the row.
    const finished = row('Finished');
    const fork = finished.getByRole('button', { name: 'Fork this conversation from here' });
    await expect(fork).toHaveCSS('opacity', '0');
    await finished.locator('[data-transcript-message-root]').hover();
    await expect(fork).toHaveCSS('opacity', '1');
    await expect(fork).toHaveAttribute('title', 'Fork from here');
    await shot(page, `${theme}-5-finished-hover`);
    await fork.click();
    await expect(page.locator('output')).toHaveAttribute('data-last-action', 'fork:entry-finished');
  });
}
