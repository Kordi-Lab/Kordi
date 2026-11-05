import { expect, test } from '@playwright/test';
import { chatConversationId, installChatFixture } from './chatFixture';

test('the browser Artifacts toolbar creates a real uploaded document message', async ({ page, baseURL }) => {
  const fixture = await installChatFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect.poll(() => fixture.sent.length).toBe(1);
  expect(fixture.uploads).toHaveLength(1);
  expect(fixture.uploads[0].length).toBeGreaterThan(0);
  expect(fixture.messages[1].attachment_ids).toEqual(['browser-file-1']);
});
