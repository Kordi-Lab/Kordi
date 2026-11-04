import type { MemoryClient } from './memoryClient';
import { importedCountLabel, memoryImportSaves, parseMemoryImportReply, type AgentInstructionFile, type MemoryImporter, type MemoryImportSave } from './memoryImport';
import type { MemoryLesson } from './memoryModel';

export type MemoryImportCounts = { imported: number; duplicates: number; failedMemories: number; failedFiles: number };
export type MemoryImportFileResult = MemoryImportCounts & { error?: string };
export type MemoryImportClient = Pick<MemoryClient, 'importLesson'> & Partial<Pick<MemoryClient, 'listLessons'>>;

const emptyCounts = (): MemoryImportCounts => ({ imported: 0, duplicates: 0, failedMemories: 0, failedFiles: 0 });
const errorLine = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not import. Try again.';

export function memoryImportSummary(counts: MemoryImportCounts): string {
  const parts: string[] = [];
  if (counts.imported) parts.push(importedCountLabel(counts.imported));
  if (counts.duplicates) parts.push(`${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'} skipped`);
  if (counts.failedMemories) parts.push(`${counts.failedMemories} memor${counts.failedMemories === 1 ? 'y' : 'ies'} could not be saved`);
  if (counts.failedFiles) parts.push(`${counts.failedFiles} file${counts.failedFiles === 1 ? '' : 's'} could not be read`);
  return parts.length ? parts.join('. ') : 'Nothing new';
}

/** Keep tree-row results short; the completion notice spells out all counts. */
export function memoryImportRowSummary(counts: MemoryImportCounts): string {
  const failed = counts.failedFiles + counts.failedMemories;
  if (!counts.imported && failed) return 'Could not import';
  const label = counts.imported ? importedCountLabel(counts.imported) : counts.duplicates ? 'Already imported' : 'Nothing new';
  return failed ? `${label} · Some failed` : label;
}

/** A save can commit before its response is lost. Verify only the exact requested scope and text. */
async function isPersisted(client: MemoryImportClient, save: MemoryImportSave): Promise<boolean> {
  if (!client.listLessons) return false;
  try {
    return (await client.listLessons()).some((lesson) => lesson.scope === save.scope
      && lesson.scopeId === save.scopeId && lesson.text === save.text);
  } catch {
    return false;
  }
}

/** Read each selected file once, count confirmed saves, and always finish the extraction run. */
export async function importMemoryBatch(
  files: AgentInstructionFile[],
  lessons: ReadonlyArray<Pick<MemoryLesson, 'text'>>,
  client: MemoryImportClient,
  importer: MemoryImporter,
  onFile: (file: AgentInstructionFile, result: MemoryImportFileResult) => void,
): Promise<MemoryImportCounts> {
  if (!client.importLesson) throw new Error('Memory import is unavailable.');
  const batch = importer.start ? await importer.start() : { extract: importer.extract.bind(importer), finish: () => Promise.resolve() };
  const existing = lessons.map((lesson) => lesson.text);
  const total = emptyCounts();
  try {
    for (const file of files) {
      const result: MemoryImportFileResult = emptyCounts();
      try {
        const memories = parseMemoryImportReply(await batch.extract(file, existing), [file]);
        const saves = memoryImportSaves(memories, [file], existing);
        result.duplicates = memories.length - saves.length;
        for (const { save } of saves) {
          try {
            await client.importLesson(save);
          } catch (error) {
            if (!await isPersisted(client, save)) {
              result.failedMemories += 1;
              result.error ??= errorLine(error);
              continue;
            }
          }
          existing.push(save.text);
          result.imported += 1;
        }
      } catch (error) {
        result.failedFiles = 1;
        result.error = errorLine(error);
      }
      total.imported += result.imported;
      total.duplicates += result.duplicates;
      total.failedMemories += result.failedMemories;
      total.failedFiles += result.failedFiles;
      onFile(file, result);
    }
    return total;
  } finally {
    // Finishing the lease does not undo saved memories. The result describes the saves.
    await batch.finish(total.failedFiles === 0 && total.failedMemories === 0).catch(() => undefined);
  }
}
