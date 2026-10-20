import { expect, test } from '@playwright/test';

// One screenshot per Common ground screen in the real Contacts page, against fixture replies.
const SCREENS: Array<[string, (page: import('@playwright/test').Page) => import('@playwright/test').Locator]> = [
  ['home', (page) => page.getByText('Recent', { exact: true })],
  ['build', (page) => page.getByText('24 titles')],
  ['card', (page) => page.getByRole('switch', { name: 'Share my card' })],
  ['lobby', (page) => page.locator('.cg-member', { hasText: 'Hana Sato' })],
  ['results', (page) => page.getByText('Eval reading group')],
  ['match', (page) => page.getByRole('button', { name: 'Chat' })],
];

test.use({ viewport: { width: 1180, height: 860 } });

for (const theme of ['light', 'dark'] as const) {
  for (const [screen, ready] of SCREENS) {
    test(`common ground ${screen} (${theme})`, async ({ page }) => {
      // The build screen is taller: connectors, agents, this Mac, links and notes.
      if (screen === 'build') await page.setViewportSize({ width: 1180, height: 1120 });
      await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
      await page.goto(`/tests/visual/commonGroundPage.html?screen=${screen}&theme=${theme}`);
      await expect(ready(page)).toBeVisible();
      if (screen === 'home') await expect(page.getByText('Reading club')).toBeVisible();
      if (screen === 'results') {
        await page.getByRole('tab', { name: 'Topics' }).click();
        await expect(page.getByRole('button', { name: 'Start a group for Retrieval' })).toBeVisible();
        await expect(page.getByText('From Eval design · 4 members')).toBeVisible();
      }
      if (screen === 'build') {
        await expect(page.getByText('AGENTS.md, CLAUDE.md +3')).toBeVisible();
        await expect(page.getByText('Connected', { exact: true })).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`commonGroundPage-${screen}-${theme}.png`);
    });
  }
}
