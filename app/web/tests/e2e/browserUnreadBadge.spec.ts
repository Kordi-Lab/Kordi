import { expect, test } from '@playwright/test';
import { isCancelledFixtureRequest } from './apiFixture';
import { installUnreadFixture, recordUnreadBadges, titleUnreadCount } from './unreadFixture';

// Opening a group link right after sign-in used to flash every unread badge:
// each catalog reload dropped the counts, reconciliation added them back, and
// group counts ignored the server read cursor. The badges must go straight to
// the server's counts and stay there.
test('unread badges settle on the server counts without flicker after signing in to a group link', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const fixture = await installUnreadFixture(page, baseURL!);
  const samples = await recordUnreadBadges(page);
  await page.goto(`/app/chats/${encodeURIComponent(fixture.openGroupSessionId)}`);
  await expect(page.getByText(`${fixture.openGroupTitle} message 10`, { exact: true }).last()).toBeVisible();
  await expect.poll(async () => titleUnreadCount(await page.title()), { timeout: 20_000 }).toBe(fixture.expectedTotal);
  // Keep watching after the counts settle: the storm repeated for minutes.
  await page.waitForTimeout(8_000);
  const recorded = await samples();

  const totals = recorded.map(sample => titleUnreadCount(sample.title));
  const drops = totals.flatMap((total, index) => index > 0 && total < totals[index - 1]
    ? [`${recorded[index].t}ms: ${totals[index - 1]} -> ${total}`] : []);
  expect(drops, 'the unread total in the title only grows while chats load').toEqual([]);
  expect(totals[totals.length - 1]).toBe(fixture.expectedTotal);

  const rowHistory = new Map<string, string[]>();
  for (const sample of recorded) {
    for (const [label, count] of Object.entries(sample.rows)) {
      const history = rowHistory.get(label) ?? [];
      if (history[history.length - 1] !== count) history.push(count);
      rowHistory.set(label, history);
    }
  }
  const changedRows = [...rowHistory].filter(([, history]) => history.length > 1);
  expect(changedRows, 'each row badge shows its settled count first').toEqual([]);
  for (const [label, history] of rowHistory) {
    expect(Number(history[0]), `${label} badge`).toBe(fixture.expectedUnread[label]);
  }
  // A row badge never disappears and comes back.
  for (const label of rowHistory.keys()) {
    const present = recorded.map(sample => label in sample.rows);
    const firstShown = present.indexOf(true);
    expect(present.slice(firstShown).every(Boolean), `${label} badge stays visible`).toBe(true);
  }
  expect(rowHistory.has(fixture.openGroupTitle), 'the open group never shows as unread').toBe(false);
  expect(errors).toEqual([]);
});
