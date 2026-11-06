import { expect, test } from '@playwright/test';
import { isCancelledFixtureRequest } from './apiFixture';
import { chatConversationId, installChatFixture } from './chatFixture';

test('browser chat sends through the hosted protocol and restores authoritative history after reload', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  const fixture = await installChatFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await expect(page.getByText('The browser conversation is ready.', { exact: true }).last()).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Send your message, use @ to mention…' });
  await composer.fill('Sent from the real browser app.');
  await composer.press('Enter');
  await expect.poll(() => fixture.sent.length).toBe(1);
  await expect(page.getByText('Sent from the real browser app.', { exact: true }).last()).toBeVisible();
  await page.locator('input[type="file"][multiple]').first().setInputFiles({
    name: 'browser-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Browser attachment bytes.'),
  });
  await expect(page.getByText('browser-note.txt', { exact: true }).first()).toBeVisible();
  await composer.fill('A file from the browser.');
  await composer.press('Enter');
  await expect.poll(() => fixture.sent.length).toBe(2);
  expect(fixture.uploads.map(bytes => bytes.toString())).toEqual(['Browser attachment bytes.']);
  expect(fixture.messages[2].attachment_ids).toEqual(['browser-file-1']);
  await page.reload();
  await expect(page.getByText('Sent from the real browser app.', { exact: true }).last()).toBeVisible();
  await page.getByText('browser-note.txt', { exact: true }).last().click({ button: 'right' });
  const finder = page.getByRole('menuitem', { name: 'Show in Finder', exact: true });
  await expect(finder).toBeDisabled();
  await expect(finder).toHaveAttribute('title', /desktop app/);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Save As…', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('browser-note.txt');
  expect(fixture.requests.every(request => !request.headers.authorization)).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});
