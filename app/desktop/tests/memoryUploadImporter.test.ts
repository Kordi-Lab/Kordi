import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudMemoryImportExtract } from '../src/features/cloud/cloudMemoryClient';
import { CloudMemoryClient } from '../src/features/cloud/cloudMemoryClient';
import type { MemoryImportChoice, MemoryImportSave } from '../src/features/memory/memoryImport';
import { importMemoryBatch } from '../src/features/memory/memoryImportBatch';
import type { MemoryLesson } from '../src/features/memory/memoryModel';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  createUploadMemoryImporter,
  readUploadedFiles,
  type UploadedFile,
} from '../src/features/memory/memoryUploadImporter';

const upload = (name: string, text: string, size = new TextEncoder().encode(text).length, lastModified = 1_760_000_000_000): UploadedFile => ({
  name,
  size,
  lastModified,
  text: () => Promise.resolve(text),
});

test('reading chosen files keeps supported ones and says why others were left out', async () => {
  const read = await readUploadedFiles([
    upload('AGENTS.md', '- Use pnpm.'),
    upload('notes.txt', 'Answer briefly.'),
    upload('memories.json', '["Use metric units."]'),
    upload('photo.png', 'binary'),
    upload('empty.md', ''),
    upload('large.md', 'x', MAX_UPLOAD_FILE_BYTES + 1),
    upload('binary.md', 'a\u0000b'),
  ], new Set(), 5);
  assert.deepEqual(read.files.map((file) => file.fileName), ['AGENTS.md', 'notes.txt', 'memories.json']);
  assert.deepEqual(read.files.map((file) => [file.source, file.root, file.projectName]), Array(3).fill(['Chosen files', null, 'Chosen files']));
  assert.equal(read.texts.get(read.files[0].path), '- Use pnpm.');
  assert.equal(read.notice, 'Choose .md, .txt, or .json files. Empty files were skipped. Files must be 200 KB or smaller.');
});

test('a list holds at most the file limit, and choosing a listed file again reads it again', async () => {
  const held = new Set(Array.from({ length: MAX_UPLOAD_FILES - 1 }, (_, index) => `upload:held-${index}`));
  const read = await readUploadedFiles([upload('a.md', '- One.'), upload('b.md', '- Two.')], held);
  assert.deepEqual(read.files.map((file) => file.fileName), ['a.md']);
  assert.equal(read.notice, `Import up to ${MAX_UPLOAD_FILES} files at a time.`);
  const again = await readUploadedFiles([upload('a.md', '- One.')], new Set([...held, read.files[0].path]));
  assert.equal(again.files.length, 1);
  assert.equal(again.notice, '');
});

test('each chosen file goes to the server model and its memories through the shared batch', async () => {
  const sent: CloudMemoryImportExtract[] = [];
  const importer = createUploadMemoryImporter({
    pick: () => Promise.resolve([upload('AGENTS.md', '# Rules\n- Use pnpm.'), upload('memories.json', '["Prefer short answers."]')]),
    extract: (input) => {
      sent.push(input);
      if (input.fileName === 'memories.json') return Promise.reject(new Error('Could not read this file. Try again.'));
      return Promise.resolve({ memories: [
        { text: 'Use pnpm for every script.', category: 'hcp-custom:task_lessons', scope: 'project' },
        { text: 'Write commit messages in English.', category: 'hcp-custom:task_lessons', scope: 'project' },
        { text: 'Prefer short answers.', category: 'general_preferences', scope: 'global' },
      ] });
    },
  });
  assert.equal(importer.hostedModel, true);
  assert.deepEqual(await importer.discover(), []);
  const choice = await importer.choose!() as MemoryImportChoice;
  const saves: MemoryImportSave[] = [];
  const results: Record<string, string> = {};
  const counts = await importMemoryBatch(choice.files, [{ text: 'Write commit messages in English.' }], {
    importLesson: (save) => { saves.push(save); return Promise.resolve({} as MemoryLesson); },
  }, importer, (file, result) => { results[file.fileName] = result.error ?? `${result.imported}/${result.duplicates}`; });
  assert.deepEqual(sent.map((input) => [input.fileName, input.text]), [
    ['AGENTS.md', '# Rules\n- Use pnpm.'],
    ['memories.json', '["Prefer short answers."]'],
  ]);
  assert.deepEqual(sent[0].existingMemories, ['Write commit messages in English.']);
  assert.deepEqual(sent[1].existingMemories, ['Write commit messages in English.', 'Use pnpm for every script.', 'Prefer short answers.'],
    'later files see the memories saved from earlier ones');
  assert.deepEqual(saves.map((save) => [save.scope, save.scopeId, save.source, save.category, save.text]), [
    ['global', 'account', 'import', 'hcp-custom:task_lessons', 'Use pnpm for every script.'],
    ['global', 'account', 'import', 'general_preferences', 'Prefer short answers.'],
  ]);
  assert.deepEqual(results, { 'AGENTS.md': '2/1', 'memories.json': 'Could not read this file. Try again.' });
  assert.deepEqual(counts, { imported: 2, duplicates: 1, failedMemories: 0, failedFiles: 1 });
});

test('a file the importer no longer holds asks to be chosen again without calling the server', async () => {
  let calls = 0;
  const importer = createUploadMemoryImporter({ pick: () => Promise.resolve([]), extract: () => { calls += 1; return Promise.resolve({ memories: [] }); } });
  await assert.rejects(importer.extract({ path: 'upload:x', root: null, projectName: 'Chosen files', fileName: 'x.md', source: 'Chosen files', size: 1, modifiedAt: 0 }, []), /Choose this file again/);
  assert.equal(calls, 0);
});

test('the cloud client posts one file to the import extraction route', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const client = new CloudMemoryClient(<T,>(path: string, init: RequestInit) => {
    requests.push({ path, init });
    return Promise.resolve({ memories: [] } as T);
  });
  await client.extractImport('token-1', { fileName: 'AGENTS.md', text: 'Use pnpm.', existingMemories: [] });
  assert.equal(requests[0].path, '/v1/cloud/memory/import/extract');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { fileName: 'AGENTS.md', text: 'Use pnpm.', existingMemories: [] });
});
