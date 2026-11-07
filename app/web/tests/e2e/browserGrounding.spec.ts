import { expect, test, type Page } from '@playwright/test';
import { account, installApiFixture, isCancelledFixtureRequest } from './apiFixture';
import { groundingPeerName, installGroundingFixture, ownPairCode, peerPairCode, stubBrowserLocation } from './groundingFixture';

async function openGrounding(page: Page) {
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: /^Grounding/ }).click();
  const grounding = page.getByRole('region', { name: 'Grounding', exact: true });
  await expect(grounding).toBeVisible();
  return grounding;
}

test('browser Grounding builds a card, pairs, and shares a browser location with Nearby', async ({ page, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  await page.setViewportSize({ width: 1440, height: 960 });
  await installApiFixture(page, baseURL!, true);
  const fixture = await installGroundingFixture(page, baseURL!);
  await stubBrowserLocation(page);
  const grounding = await openGrounding(page);

  // An unbuilt card opens Build in place; Calendar, Reminders and agent files need the Mac app.
  await expect(grounding.getByRole('textbox', { name: 'Notes', exact: true })).toBeVisible();
  await expect(grounding.getByText('On this Mac', { exact: true })).toHaveCount(0);
  await grounding.getByRole('textbox', { name: 'Notes', exact: true }).fill('Synthetic fixture notes.');
  await grounding.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(grounding.getByText('Your card', { exact: true })).toBeVisible();
  await expect(grounding.getByText('Trail running', { exact: true })).toBeVisible();
  expect(fixture.requests.find(row => row.path.endsWith('/card/build'))?.body).toMatchObject({ notes: 'Synthetic fixture notes.' });

  await grounding.getByRole('button', { name: 'Pair', exact: true }).click();
  const pair = page.getByRole('dialog', { name: 'Pair', exact: true });
  await expect(pair.getByText(ownPairCode, { exact: true })).toBeVisible();
  await pair.getByRole('textbox', { name: 'Their code', exact: true }).fill(peerPairCode);
  await pair.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(grounding.getByText(groundingPeerName, { exact: true })).toBeVisible();
  await expect(grounding.getByText('Synthetic fixture: you both run trails.', { exact: true })).toBeVisible();
  await grounding.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(grounding.getByText('Recent', { exact: true })).toBeVisible();

  await grounding.getByRole('button', { name: /^Nearby/ }).click();
  await grounding.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
  await grounding.getByRole('button', { name: 'Use this device’s location', exact: true }).click();
  await expect(grounding.getByText(/^Location updated/)).toBeVisible();
  await expect(grounding.getByText('No matches nearby', { exact: true })).toBeVisible();
  const location = fixture.requests.find(row => row.path.endsWith('/nearby/location'))?.body as { latitude: number; longitude: number; accuracy: number };
  expect(location).toMatchObject({ latitude: 37.428, longitude: -122.17, accuracy: 30 });

  // Every Grounding call rides the cookie session, never a bearer token.
  expect(fixture.requests.length).toBeGreaterThan(0);
  for (const request of fixture.requests) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-kordi-web-account']).toBe(account.accountId);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-grounding-nearby.png') });
});

test('390px browser stacks the Grounding deck above one column and keeps Pair on screen', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApiFixture(page, baseURL!, true);
  await installGroundingFixture(page, baseURL!, { built: true });
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.getByRole('button', { name: /^Grounding/ }).click();
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  const grounding = page.getByRole('region', { name: 'Grounding', exact: true });
  await expect(grounding.getByText('Your card', { exact: true })).toBeVisible();

  const rail = await grounding.getByRole('navigation', { name: 'Cards', exact: true }).boundingBox();
  const column = await grounding.locator('.cg-wallet-col').boundingBox();
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(column!.y);
  expect(column!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await grounding.getByRole('button', { name: 'Pair', exact: true }).click();
  const pair = page.getByRole('dialog', { name: 'Pair', exact: true });
  await expect(pair.getByText(ownPairCode, { exact: true })).toBeVisible();
  const box = await pair.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-grounding-390.png') });
});
