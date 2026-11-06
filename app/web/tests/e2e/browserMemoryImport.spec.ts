import { expect, test, type Page, type TestInfo } from '@playwright/test';
import process from 'node:process';
import path from 'node:path';
import { isCancelledFixtureRequest } from './apiFixture';
import { chatConversationId, installChatFixture } from './chatFixture';
import { installMemoryFixture, syntheticChatMemory } from './memoryFixture';

const agentsFile = [
  '# Synthetic rules',
  '',
  'Rules:',
  '- Synthetic import: use pnpm for every script.',
  '- Synthetic import: keep commit messages in English.',
  '',
  '```sh',
  'pnpm install',
  '```',
].join('\n');

/** Screenshots go to KORDI_WEB_MEMORY_IMPORT_SHOTS when it is set, otherwise to the test output. */
const shot = (testInfo: TestInfo, name: string) => {
  const folder = process.env.KORDI_WEB_MEMORY_IMPORT_SHOTS;
  return folder ? path.join(folder, `${testInfo.project.name}-${name}`) : testInfo.outputPath(name);
};

type ExtractBody = { fileName: string; text: string; existingMemories: string[] };

/** The server's import model, stubbed: it answers by file name and records what it was sent. */
async function stubImportModel(page: Page, refuse = false) {
  const sent: ExtractBody[] = [];
  await page.route('**/v1/cloud/memory/import/extract', async route => {
    const body = route.request().postDataJSON() as ExtractBody;
    sent.push(body);
    if (refuse) {
      return route.fulfill({ status: 403, json: { errorCode: 'ai_consent_required', message: 'AI models are off. Allow them in Settings › Privacy to use agents.' } });
    }
    const memories = body.fileName === 'AGENTS.md'
      ? [
          { text: 'Synthetic import: use pnpm for every script.', category: 'hcp-custom:task_lessons', scope: 'project' },
          { text: 'Synthetic import: keep commit messages in English.', category: 'hcp-custom:task_lessons', scope: 'project' },
        ]
      : [{ text: 'Synthetic import: prefer short answers.', category: 'general_preferences', scope: 'global' }];
    return route.fulfill({ json: { memories } });
  });
  return sent;
}

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!isCancelledFixtureRequest(error.message)) errors.push(error.message); });
  return errors;
}

test('the chat Memory tab shows Import beside Add memory', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = collectPageErrors(page);
  await installChatFixture(page, baseURL!);
  await installMemoryFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const memory = page.getByRole('region', { name: 'Memory', exact: true });
  await expect(memory.getByText(syntheticChatMemory, { exact: true })).toBeVisible();
  await expect(memory.locator('[data-memory-add]').getByRole('button')).toHaveText(['Import', 'Add memory']);
  await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'memory-tab-import.png') });
  expect(errors).toEqual([]);
});

test('Import in an empty Memory tab opens Settings › Memory and imports chosen files', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = collectPageErrors(page);
  await installChatFixture(page, baseURL!);
  const fixture = await installMemoryFixture(page, baseURL!);
  const sent = await stubImportModel(page);
  fixture.memories.splice(fixture.memories.findIndex(row => row.text === syntheticChatMemory), 1);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const empty = page.locator('[data-memory-empty]');
  await expect(empty.getByText('No memories yet', { exact: true })).toBeVisible();
  await expect(empty.getByRole('button')).toHaveText(['Import', 'Add memory']);
  await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'memory-tab-empty-import.png') });

  await empty.getByRole('button', { name: 'Import', exact: true }).click();
  const section = page.locator('#memory-import');
  await expect(section.getByRole('heading', { name: 'Import', exact: true })).toBeInViewport();
  await expect(section.getByText('No files chosen')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'settings-memory-import-empty.png') });

  const chooser = page.waitForEvent('filechooser');
  await section.getByRole('button', { name: 'Choose files…', exact: true }).click();
  await (await chooser).setFiles([
    { name: 'AGENTS.md', mimeType: 'text/markdown', buffer: Buffer.from(agentsFile) },
    { name: 'memories.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(['Synthetic import: prefer short answers.'])) },
    { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not text') },
  ]);
  await expect(section.getByText(/2 files selected · Choose \.md, \.txt, or \.json files\./)).toBeVisible();
  await section.getByRole('treeitem', { name: 'Chosen files' }).locator(':scope > div > button:not([aria-hidden])').click();
  await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'settings-memory-import-chosen.png') });

  await section.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(section.getByText('Imported 3 memories.')).toBeVisible();
  // Each file's text went to the import model once, and nothing else was uploaded.
  expect(sent.map(body => [body.fileName, body.text])).toEqual([
    ['AGENTS.md', agentsFile],
    ['memories.json', JSON.stringify(['Synthetic import: prefer short answers.'])],
  ]);
  expect(sent[1].existingMemories).toContain('Synthetic import: use pnpm for every script.');
  const imported = fixture.memories.filter(row => row.source === 'import');
  expect(imported.map(row => [row.scope, row.scopeId, row.text])).toEqual([
    ['global', 'account', 'Synthetic import: use pnpm for every script.'],
    ['global', 'account', 'Synthetic import: keep commit messages in English.'],
    ['global', 'account', 'Synthetic import: prefer short answers.'],
  ]);
  await expect(page.getByText('Synthetic import: prefer short answers.', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'settings-memory-import-done.png') });
  expect(errors).toEqual([]);
});

test('the Import memory tour walks the browser upload flow when the server reports Memory', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = collectPageErrors(page);
  await installChatFixture(page, baseURL!);
  await installMemoryFixture(page, baseURL!);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('button', { name: /^Help & setup/ }).click();
  await page.getByRole('button', { name: 'Import memory', exact: true }).click();
  const card = page.locator('.help-tour-card[data-positioned="true"]');
  const titles: string[] = [];
  for (;;) {
    await expect(card).toBeVisible({ timeout: 10_000 });
    const title = (await card.getByRole('heading').textContent()) ?? '';
    titles.push(title);
    if (title === 'Choose the files to import') {
      await expect(card).toContainText('Click Choose files');
      await page.screenshot({ animations: 'disabled', path: shot(testInfo, 'tour-import-choose-files.png') });
    }
    const finish = card.getByRole('button', { name: 'Finish tour', exact: true });
    const next = card.getByRole('button', { name: 'Next', exact: true });
    if (title === 'Review what was imported' || await finish.isVisible()) break;
    await next.click();
    await expect(card.getByRole('heading')).not.toHaveText(title, { timeout: 10_000 });
  }
  expect(titles).toEqual([
    'Bring your existing knowledge into Kordi', 'Choose the files to import', 'Import the selected files', 'Review what was imported',
  ]);
  expect(errors).toEqual([]);
});

test('a server refusal for AI consent marks the file and opens the AI models prompt', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = collectPageErrors(page);
  await installChatFixture(page, baseURL!);
  const fixture = await installMemoryFixture(page, baseURL!);
  await stubImportModel(page, true);
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.getByRole('region', { name: 'Memory', exact: true }).getByRole('button', { name: 'Import', exact: true }).click();
  const section = page.locator('#memory-import');
  const chooser = page.waitForEvent('filechooser');
  await section.getByRole('button', { name: 'Choose files…', exact: true }).click();
  await (await chooser).setFiles([{ name: 'AGENTS.md', mimeType: 'text/markdown', buffer: Buffer.from(agentsFile) }]);
  await section.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AI models are off' })).toBeVisible();
  await expect(section.getByText('1 file could not be read.')).toBeVisible();
  expect(fixture.memories.filter(row => row.source === 'import')).toEqual([]);
  expect(errors).toEqual([]);
});
