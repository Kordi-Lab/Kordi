import { expect, test } from '@playwright/test';
import { account } from './apiFixture';
import { chatConversationId, installChatFixture } from './chatFixture';

test('switching organizations clears the previous transcript and survives refresh without a remount loop', async ({ page, baseURL }) => {
  const errors: string[] = [];
  let reloading = false;
  // WebKit reports requests that a reload cancels as page errors; those are not app failures.
  const cancelledByReload = /access control checks|Load failed|Failed to fetch|cancelled/i;
  page.on('pageerror', error => {
    if (!(reloading && cancelledByReload.test(error.message))) errors.push(error.message);
  });
  await installChatFixture(page, baseURL!);
  let organizationId = 'browser-test-org';
  let switches = 0;
  let bootstraps = 0;
  await page.route('**/v1/cloud/organizations', route => route.fulfill({ json: { organizations: [
    { organizationId: 'browser-test-org', name: 'Test workspace', kind: 'personal', role: 'owner', memberCount: 1 },
    { organizationId: 'browser-team-org', name: 'Second workspace', kind: 'team', role: 'member', memberCount: 2 },
  ] } }));
  await page.route('**/v1/cloud/auth/web/session', route => route.fulfill({ json: {
    account, csrfToken: 'synthetic-csrf', session: { organizationId, deviceId: 'browser-test-device' },
  } }));
  await page.route('**/v1/cloud/auth/organization-token', route => {
    organizationId = (route.request().postDataJSON() as { organization_id: string }).organization_id;
    switches += 1;
    return route.fulfill({ json: { account_id: account.accountId, device_id: 'browser-test-device', organization_id: organizationId } });
  });
  await page.route('**/v2/chat/**', route => {
    if (organizationId !== 'browser-team-org') return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === '/v2/chat/sync/bootstrap') {
      bootstraps += 1;
      return route.fulfill({ json: { protocol_version: 2, conversations: [], latest_messages: [],
        next_cursor: 'second-org-empty', last_stream_seq: 0, server_time: '2026-11-05T12:00:00Z' } });
    }
    if (path === '/v2/chat/sync') return route.fulfill({ json: { protocol_version: 2, events: [],
      next_cursor: 'second-org-empty', last_stream_seq: 0, has_more: false, server_time: '2026-11-05T12:00:00Z' } });
    return route.fulfill({ status: 404, json: { errorCode: 'not_found' } });
  });
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open account settings', exact: true })).toBeVisible();
  // Newer account menus list organizations on a second level behind the current one.
  const organizationEntry = page.getByRole('button', { name: /^Organization: / });
  if (await organizationEntry.count()) await organizationEntry.click();
  await page.getByRole('button', { name: /^Second workspace( \d+)?$/ }).click();
  await expect.poll(() => switches).toBe(1);
  await expect(page.getByText('The browser conversation is ready.', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Contacts', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  reloading = true;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Contacts', exact: true }).first()).toBeVisible();
  reloading = false;
  await expect(page.getByText('The browser conversation is ready.', { exact: true })).toHaveCount(0);
  expect(bootstraps).toBeGreaterThan(0);
  // Startup and refresh each initialize several hosted projections. A remount
  // loop keeps adding requests after the restored page has settled.
  await page.waitForTimeout(1_000);
  const settledBootstraps = bootstraps;
  await page.waitForTimeout(1_000);
  expect(bootstraps).toBe(settledBootstraps);
  expect(bootstraps).toBeLessThanOrEqual(12);
  expect(errors).toEqual([]);
});
