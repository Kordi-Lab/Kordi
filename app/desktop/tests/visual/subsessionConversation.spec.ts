import { test, expect } from '@playwright/test';

test('subsession has a bounded transcript, visible composer, and explicit identity-bound mentions', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/subsessionConversation.html');
  const field = page.getByRole('textbox');
  await expect(page.getByRole('heading', { name: 'Planet research' })).toBeVisible();
  await expect(page.getByText('Queued next', { exact: true })).toBeVisible();
  await expect(field).toBeVisible();
  const bounds = await field.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height);
  await field.fill('Hello everyone');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests: {mentions: unknown[]}[]}).sentSubsessionRequests[0]?.mentions.length)).toBe(0);
  await expect(field).toBeEditable();
  await expect(field).toHaveText('');
  await field.pressSequentially('@Kordi');
  await page.getByRole('option').filter({ hasText: "Alex's Kordi" }).click();
  await expect(field).toContainText('@KordiAlex');
  await page.evaluate(() => {
    const snapshot = (window as unknown as {fixtureSubsession: {agentDisplayName: string; version: number}}).fixtureSubsession;
    snapshot.agentDisplayName = 'Research Agent'; snapshot.version += 1;
  });
  await expect(page.getByText('Research Agent · Owner · Alex', { exact: true })).toBeVisible();
  await field.pressSequentially(' continue');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests: unknown[]}).sentSubsessionRequests[1])).toEqual({ clientMessageId: expect.any(String), text: expect.stringMatching(/^@KordiAlex\s+continue$/), mentions: [expect.objectContaining({ agentId: 'fixture-agent' })] });
  await expect(page.getByText('processing...', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('conversation.png') });
});
