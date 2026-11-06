import assert from 'node:assert/strict';
import test from 'node:test';

import type { MemoryImportChoice, MemoryImportSave } from '../src/features/memory/memoryImport';
import { importMemoryBatch } from '../src/features/memory/memoryImportBatch';
import type { MemoryLesson } from '../src/features/memory/memoryModel';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_MEMORIES_PER_FILE,
  createUploadMemoryImporter,
  jsonFileMemories,
  readUploadedFiles,
  textFileMemories,
  uploadedFileReply,
  type UploadedFile,
} from '../src/features/memory/memoryUploadImporter';

const upload = (name: string, text: string, size = new TextEncoder().encode(text).length, lastModified = 1_760_000_000_000): UploadedFile => ({
  name,
  size,
  lastModified,
  text: () => Promise.resolve(text),
});

const AGENTS = `# Repository rules

Rules:
- Use pnpm for every script.
- Run the **targeted** tests before a commit.
  Keep them fast.
1. Write commit messages in English.

\`\`\`sh
pnpm install
\`\`\`

| Command | Use |
| --- | --- |
| pnpm dev | Preview |

Keep headings short and plain. See [the guide](https://example.test/guide).
<!-- private note -->
`;

test('Markdown list items and paragraphs become memories; headings, lead-ins, code, tables, and comments do not', () => {
  assert.deepEqual(textFileMemories(AGENTS).map((memory) => memory.text), [
    'Use pnpm for every script.',
    'Run the targeted tests before a commit. Keep them fast.',
    'Write commit messages in English.',
    'Keep headings short and plain. See the guide.',
  ]);
  assert.ok(textFileMemories(AGENTS).every((memory) => memory.category === 'hcp-custom:task_lessons'));
});

test('Claude Code memory frontmatter sets the category, and reference files add nothing', () => {
  const memory = (type: string) => `---\nname: Example\ndescription: An example\ntype: ${type}\n---\nAnswer in British English.\n`;
  assert.deepEqual(textFileMemories(memory('user')), [{ text: 'Answer in British English.', category: 'general_preferences', scope: 'global' }]);
  assert.equal(textFileMemories(memory('feedback'))[0].category, 'hcp-custom:task_lessons');
  assert.equal(textFileMemories(memory('project'))[0].category, 'work_context');
  assert.deepEqual(textFileMemories(memory('reference')), []);
});

test('a paragraph over the memory length is split at sentence ends', () => {
  const sentence = `${'word '.repeat(40).trim()}.`;
  const memories = textFileMemories(Array.from({ length: 4 }, () => sentence).join(' '));
  assert.ok(memories.length >= 2);
  assert.ok(memories.every((memory) => memory.text.length <= 500));
  assert.equal(memories.map((memory) => memory.text).join(' '), Array.from({ length: 4 }, () => sentence).join(' '));
});

test('JSON files hold texts or text objects, alone or under memories', () => {
  assert.deepEqual(jsonFileMemories('["Prefer short answers."]'), [{ text: 'Prefer short answers.', scope: 'global' }]);
  assert.deepEqual(
    jsonFileMemories(JSON.stringify({ memories: [{ text: 'Use metric units.', category: 'general_preferences' }, { content: 'Works on the docs site.', scope: 'project' }, 3] })),
    [
      { text: 'Use metric units.', category: 'general_preferences', scope: 'global' },
      { text: 'Works on the docs site.', category: undefined, scope: 'project' },
    ],
  );
  assert.throws(() => jsonFileMemories('{'), /not valid JSON/);
  assert.throws(() => jsonFileMemories('{"name":"x"}'), /no list of memories/);
});

test('one file adds at most the per-file limit', () => {
  const text = Array.from({ length: MAX_UPLOAD_MEMORIES_PER_FILE + 10 }, (_, index) => `- Rule ${index}.`).join('\n');
  const reply = JSON.parse(uploadedFileReply({ path: 'upload:a', fileName: 'AGENTS.md' }, text)) as { memories: Array<{ file: string }> };
  assert.equal(reply.memories.length, MAX_UPLOAD_MEMORIES_PER_FILE);
  assert.ok(reply.memories.every((memory) => memory.file === 'upload:a'));
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
  const first = upload('a.md', '- One.');
  const read = await readUploadedFiles([first, upload('b.md', '- Two.')], held);
  assert.deepEqual(read.files.map((file) => file.fileName), ['a.md']);
  assert.equal(read.notice, `Import up to ${MAX_UPLOAD_FILES} files at a time.`);
  const again = await readUploadedFiles([upload('a.md', '- One.')], new Set([...held, read.files[0].path]));
  assert.equal(again.files.length, 1);
  assert.equal(again.notice, '');
});

test('the upload importer feeds chosen files through the shared batch and saves each memory once', async () => {
  const importer = createUploadMemoryImporter(() => Promise.resolve([
    upload('AGENTS.md', AGENTS),
    upload('memories.json', JSON.stringify(['Prefer short answers.', 'Use pnpm for every script.'])),
    upload('broken.json', '{'),
  ]));
  assert.equal(importer.readsLocally, true);
  assert.deepEqual(await importer.discover(), []);
  const choice = await importer.choose!() as MemoryImportChoice;
  assert.equal(choice.files.length, 3);
  const saves: MemoryImportSave[] = [];
  const results: Record<string, string> = {};
  const lessons: Pick<MemoryLesson, 'text'>[] = [{ text: 'Write commit messages in English.' }];
  const counts = await importMemoryBatch(choice.files, lessons, {
    importLesson: (save) => { saves.push(save); return Promise.resolve({} as MemoryLesson); },
  }, importer, (file, result) => { results[file.fileName] = result.error ?? `${result.imported}/${result.duplicates}`; });
  assert.deepEqual(saves.map((save) => save.text), [
    'Use pnpm for every script.',
    'Run the targeted tests before a commit. Keep them fast.',
    'Keep headings short and plain. See the guide.',
    'Prefer short answers.',
  ]);
  assert.ok(saves.every((save) => save.scope === 'global' && save.scopeId === 'account' && save.source === 'import'));
  assert.deepEqual(results, { 'AGENTS.md': '3/1', 'memories.json': '1/1', 'broken.json': 'This file is not valid JSON.' });
  assert.deepEqual(counts, { imported: 4, duplicates: 2, failedMemories: 0, failedFiles: 1 });
});

test('a file the importer no longer holds asks to be chosen again', async () => {
  const importer = createUploadMemoryImporter(() => Promise.resolve([]));
  await assert.rejects(importer.extract({ path: 'upload:x', root: null, projectName: 'Chosen files', fileName: 'x.md', source: 'Chosen files', size: 1, modifiedAt: 0 }, []), /Choose this file again/);
});
