import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

test('the tour ring follows the chat theme accent and the popover sits beside wide targets', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light&chatTheme=sand');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const card = page.locator('.help-tour-card');
  const spotlight = page.locator('.help-tour-spotlight');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(spotlight).toHaveAttribute('data-target', 'grounding-cards');
  // The ring uses the theme accent, not a fixed blue.
  const colors = await spotlight.evaluate((ring) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--app-accent)';
    ring.parentElement!.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { ring: getComputedStyle(ring).borderTopColor, width: getComputedStyle(ring).borderTopWidth, accent };
  });
  expect(colors.ring).toBe(colors.accent);
  expect(colors.width).toBe('2px');
  for (let index = 0; index < 5; index += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(spotlight).toHaveAttribute('data-target', 'grounding-topics');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  // The card section is too wide to have room on its right, so the popover sits right below it.
  await expect.poll(async () => {
    const target = await page.locator('[data-help-target="grounding-topics"]').boundingBox();
    const popover = await card.boundingBox();
    return Boolean(target && popover && popover.y >= target.y + target.height && popover.y - (target.y + target.height) <= 30
      && Math.abs(popover.x - target.x) <= 12);
  }).toBe(true);
  await expect(page.locator('.help-tour-arrow')).toHaveAttribute('data-side', 'bottom');
  await page.screenshot({ path: test.info().outputPath('tour-topics-sand-light.png') });
});
