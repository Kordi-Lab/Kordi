import { expect, test } from '@playwright/test';
import { chatConversationId } from './chatFixture';
import {
  hiddenTranscriptFrames, installFrameRecorder, installPresenceAndPlanCard, subtitlesSeen, takeFrames, visibleCardBoxes,
} from './presencePlanCardFixture';

test('chat header presence, the plan card, and history stay still when the chat opens and when pages switch', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installFrameRecorder(page);
  const { presenceRequests } = await installPresenceAndPlanCard(page, baseURL!, { history: 30 });
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  const card = page.locator('section.app-plan-card');
  const subtitle = page.locator('[data-chat-session-subtitle="true"]');
  await expect(card.getByRole('button', { name: "I'm in" })).toBeVisible();
  await expect(subtitle).toHaveText('online');
  await page.waitForTimeout(800);
  const firstOpen = await takeFrames(page);
  // Unknown presence shows nothing; it never guesses "last seen recently" first.
  expect(subtitlesSeen(firstOpen)).toEqual(['online']);
  expect(visibleCardBoxes(firstOpen)).toHaveLength(1);

  const away = {
    Contacts: () => page.getByRole('link', { name: 'Contacts', exact: true }).first().click(),
    Digest: () => page.getByRole('link', { name: 'Digest', exact: true }).first().click(),
    Info: () => page.getByRole('tab', { name: 'Info', exact: true }).click(),
  };
  const back = {
    Contacts: () => page.getByRole('link', { name: /^Chats\b/ }).first().click(),
    Digest: () => page.getByRole('link', { name: /^Chats\b/ }).first().click(),
    Info: () => page.getByRole('tab', { name: 'Messages', exact: true }).click(),
  };
  for (const name of ['Contacts', 'Info', 'Digest'] as const) {
    await away[name]();
    await expect(card).toHaveCount(0);
    await takeFrames(page);
    await back[name]();
    await expect(card).toBeVisible();
    await expect(subtitle).toHaveText('online');
    await page.waitForTimeout(800);
    const reopened = await takeFrames(page);
    expect(subtitlesSeen(reopened), `presence after returning from ${name}`).toEqual(['online']);
    expect(visibleCardBoxes(reopened), `plan card after returning from ${name}`).toHaveLength(1);
    // A chat already seen paints its history at once, with no hidden measuring frame.
    expect(hiddenTranscriptFrames(reopened), `hidden history frames after returning from ${name}`).toBe(0);
  }
  expect(presenceRequests()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
