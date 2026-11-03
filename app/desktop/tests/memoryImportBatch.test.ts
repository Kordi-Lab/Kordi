import assert from 'node:assert/strict';
import test from 'node:test';

import { importMemoryBatch, type MemoryImportFileResult } from '../src/features/memory/memoryImportBatch';
import type { AgentInstructionFile } from '../src/features/memory/memoryImport';
import type { MemoryLesson } from '../src/features/memory/memoryModel';

const file: AgentInstructionFile = { path: '/sample/rules.md', root: '/sample', projectName: 'Sample', fileName: 'rules.md', source: 'Chosen files', size: 32, modifiedAt: 1 };
const text = 'Use four headings for meeting notes.';
const reply = JSON.stringify({ memories: [{ text }] });
const stored: MemoryLesson = { lessonId: 'synthetic-memory', text, scope: 'project', scopeId: '/sample', scopeLabel: 'Sample', source: 'import', createdAt: 'now', updatedAt: 'now' };

for (const mismatch of [
  { ...stored, scopeId: '/another-project' },
  { ...stored, scope: 'global' as const },
  { ...stored, text: text.toUpperCase() },
]) {
  test(`a failed save is not confirmed by a different persisted memory: ${mismatch.scope}/${mismatch.scopeId}/${mismatch.text}`, async () => {
    const results: MemoryImportFileResult[] = [];
    const outcome = await importMemoryBatch([file], [], {
      importLesson: async () => { throw new Error('Save interrupted.'); },
      listLessons: async () => [mismatch],
    }, { discover: async () => [file], extract: async () => reply }, (_, result) => { results.push(result); });
    assert.deepEqual(outcome, { imported: 0, duplicates: 0, failedMemories: 1, failedFiles: 0 });
    assert.equal(results[0].error, 'Save interrupted.');
  });
}

test('unavailable reconciliation preserves the failed count and still finishes the run', async () => {
  const finished: boolean[] = [];
  const outcome = await importMemoryBatch([file], [], {
    importLesson: async () => { throw new Error('Save interrupted.'); },
    listLessons: async () => { throw new Error('Offline.'); },
  }, {
    discover: async () => [file], extract: async () => reply,
    start: async () => ({ extract: async () => reply, finish: async (ok) => { finished.push(ok); } }),
  }, () => undefined);
  assert.equal(outcome.failedMemories, 1);
  assert.deepEqual(finished, [false]);
});

test('confirmed saves deduplicate later files and survive a completion failure', async () => {
  let saves = 0;
  const outcome = await importMemoryBatch([file, { ...file, path: '/sample/other.md' }], [], {
    importLesson: async () => { saves += 1; return stored; },
  }, {
    discover: async () => [file], extract: async () => reply,
    start: async () => ({ extract: async () => reply, finish: async () => { throw new Error('Lease completion interrupted.'); } }),
  }, () => undefined);
  assert.equal(saves, 1);
  assert.deepEqual(outcome, { imported: 1, duplicates: 1, failedMemories: 0, failedFiles: 0 });
});
