import { expect, test, type Page } from '@playwright/test';
import { account } from './apiFixture';
import { chatConversationId, installChatFixture } from './chatFixture';
import { installMemoryFixture, syntheticChatMemory, syntheticGlobalMemory } from './memoryFixture';

async function openMemorySettings(page: Page) {
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page.getByRole('button', { name: 'Open account settings', exact: true }).click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
}

test('browser Memory settings load, edit, create, and preserve server changes across reload', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installChatFixture(page, baseURL!);
  const fixture = await installMemoryFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await openMemorySettings(page);
  await expect(page.getByText(syntheticGlobalMemory, { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Let Kordi save memories' })).toBeChecked();
  const globalRow = page.locator('[data-memory-lesson="synthetic-memory-global"]');
  await globalRow.getByRole('button', { name: /^Edit memory:/ }).click();
  const edited = 'Synthetic review: prefer short, concrete answers.';
  await globalRow.getByRole('textbox', { name: /^Edit memory:/ }).fill(edited);
  await globalRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(edited, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'New memory', exact: true }).fill('Synthetic review: include the next action.');
  await page.locator('[data-memory-new]').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Synthetic review: include the next action.', { exact: true })).toBeVisible();
  await page.reload();
  await openMemorySettings(page);
  await expect(page.getByText(edited, { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic review: include the next action.', { exact: true })).toBeVisible();
  expect(fixture.memories).toHaveLength(3);
  for (const request of fixture.requests.filter(row => row.method !== 'GET')) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-kordi-web-account']).toBe(account.accountId);
  }
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('synthetic-memory-settings.png') });
});

test('browser chat Memory tab uses the shared conversation memory page', async ({ page, baseURL }) => {
  await installChatFixture(page, baseURL!);
  await installMemoryFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const memory = page.getByRole('region', { name: 'Memory', exact: true });
  await expect(memory).toBeVisible();
  await expect(memory.getByText(syntheticChatMemory, { exact: true })).toBeVisible();
  await expect(memory.getByText(syntheticGlobalMemory, { exact: true })).toHaveCount(0);
  await expect(memory.getByRole('button', { name: 'Add memory', exact: true })).toBeVisible();
});

test('browser hides Memory when the server does not advertise memory routes', async ({ page, baseURL }) => {
  await installChatFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await expect(page.getByRole('tab', { name: 'Messages', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Memory', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page.getByRole('button', { name: 'Open account settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Memory', exact: true })).toHaveCount(0);
});
