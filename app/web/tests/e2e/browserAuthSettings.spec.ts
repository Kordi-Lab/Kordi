import { expect, test } from '@playwright/test';
import { installApiFixture, isCancelledFixtureRequest } from './apiFixture';
import type { CloudProviderAuthSnapshot } from '@/features/cloud/cloudAgentRuntimeTypes';

// Protocol fixtures validate the real settings controls and request wiring;
// provider credential verification still needs a configured development service.
test('browser Authentication refreshes hosted accounts and saves a Custom API account', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  let snapshotReads = 0;
  const snapshots: CloudProviderAuthSnapshot[] = [];
  let saved = false;
  await page.route('**/v1/cloud/agent-provider-auth/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBeUndefined();
    if (path.endsWith('/catalog')) return route.fulfill({ json: { providers: [] } });
    if (path.endsWith('/validate-key')) return route.fulfill({ json: { verified: true } });
    if (path.endsWith('/snapshots') && request.method() === 'GET') {
      snapshotReads += 1;
      return route.fulfill({ json: { snapshots } });
    }
    if (path.endsWith('/snapshots') && request.method() === 'POST') {
      const input = request.postDataJSON() as { provider: string; authChoice: string; label: string; payload: { model: string } };
      expect(input.provider).toBe('custom');
      const snapshot = { snapshotId: 'snap_browser_fixture', provider: input.provider,
        authChoice: input.authChoice, label: input.label, modelHint: input.payload.model,
        createdAt: '2026-11-05T12:00:00Z', revokedAt: null };
      snapshots.push(snapshot); saved = true;
      return route.fulfill({ json: snapshot });
    }
    return route.fulfill({ status: 404, json: { errorCode: 'fixture_route_unavailable' } });
  });
  await page.goto('/app/chats');
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page.getByRole('button', { name: 'Open account settings', exact: true }).click();
  await page.getByRole('button', { name: 'Authentication', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search providers' })).toBeVisible();
  await expect(page.getByText(/Native desktop sign-in appears here/)).toHaveCount(0);
  const beforeRefresh = snapshotReads;
  await page.getByRole('button', { name: 'Refresh providers' }).click();
  await expect.poll(() => snapshotReads).toBeGreaterThan(beforeRefresh);
  await expect(page.getByText(/This feature requires the Kordi desktop app/)).toHaveCount(0);
  await page.getByText('Custom API', { exact: true }).click();
  await page.getByText('Add account', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Browser fixture account');
  await page.getByRole('textbox', { name: 'API base URL', exact: true }).fill('https://fixture.example/v1');
  await page.getByRole('textbox', { name: 'Model ID', exact: true }).fill('fixture-model');
  await page.getByLabel('API key', { exact: true }).fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page.getByRole('group', { name: 'Browser fixture account', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
