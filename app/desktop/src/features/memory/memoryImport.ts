import { isMemoryCategory, type MemoryCategory } from './memoryCategory';
import { validateLessonText, type MemoryLessonScope } from './memoryModel';

/** An agent instruction file this Mac found (`desktop_memory_import_discover`). */
export type AgentInstructionFile = {
  path: string;
  /** The project root; null for a file in the home folder. */
  root: string | null;
  projectName: string;
  fileName: string;
  size: number;
  /** Milliseconds since the Unix epoch. */
  modifiedAt: number;
};

/** Finds agent files and reads one into the model's JSON reply. */
export type MemoryImporter = {
  discover(): Promise<AgentInstructionFile[]>;
  extract(file: AgentInstructionFile, existingMemories: string[]): Promise<string>;
};

/** A memory the model read from a file, after checks. */
export type ImportedMemory = {
  text: string;
  category: MemoryCategory;
  scope: 'project' | 'global';
  file: string;
};

/** What the page saves for one imported memory: always user-declared, so no confidence. */
export type MemoryImportSave = {
  scope: MemoryLessonScope;
  scopeId: string;
  scopeLabel: string;
  source: 'import';
  text: string;
  category: MemoryCategory;
};

export const MAX_MEMORIES_PER_FILE = 12;

function jsonObjectOf(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The memories in a model reply, for the files that were sent. The reply may wrap the JSON in a
 * fence or a sentence. Entries without text, or for a file that was not sent, are dropped; an entry
 * without a file belongs to the only file sent. Each file keeps at most 12.
 */
export function parseMemoryImportReply(reply: string, files: ReadonlyArray<Pick<AgentInstructionFile, 'path'>>): ImportedMemory[] {
  const parsed = jsonObjectOf(reply);
  const entries = parsed && typeof parsed === 'object' ? (parsed as { memories?: unknown }).memories : null;
  if (!Array.isArray(entries)) return [];
  const paths = new Set(files.map((file) => file.path));
  const onlyFile = files.length === 1 ? files[0].path : null;
  const perFile = new Map<string, number>();
  const memories: ImportedMemory[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const validation = validateLessonText(typeof record.text === 'string' ? record.text : '');
    if (!validation.ok) continue;
    const file = typeof record.file === 'string' && paths.has(record.file) ? record.file : onlyFile;
    if (!file) continue;
    const count = perFile.get(file) ?? 0;
    if (count >= MAX_MEMORIES_PER_FILE) continue;
    perFile.set(file, count + 1);
    const scope = record.scope === 'global' ? 'global' : 'project';
    const category = isMemoryCategory(record.category)
      ? record.category
      : scope === 'global' ? 'general_preferences' : 'hcp-custom:task_lessons';
    memories.push({ text: validation.text, category, scope, file });
  }
  return memories;
}

/** Compares memory texts the way the page skips repeats: trimmed, spaces collapsed, any case. */
export function memoryTextKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The saves for imported memories, skipping texts already in `existingTexts` or earlier in the
 * list. A project memory is saved to the file's project (its root and name); a memory from a file
 * in the home folder, or a global one, is saved to the account.
 */
export function memoryImportSaves(
  memories: ReadonlyArray<ImportedMemory>,
  files: ReadonlyArray<AgentInstructionFile>,
  existingTexts: Iterable<string>,
): Array<{ file: string; save: MemoryImportSave }> {
  const seen = new Set(Array.from(existingTexts, memoryTextKey));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const saves: Array<{ file: string; save: MemoryImportSave }> = [];
  for (const memory of memories) {
    const key = memoryTextKey(memory.text);
    const file = byPath.get(memory.file);
    if (!file || seen.has(key)) continue;
    seen.add(key);
    const project = memory.scope === 'project' && file.root ? file : null;
    saves.push({
      file: file.path,
      save: {
        scope: project ? 'project' : 'global',
        scopeId: project?.root ?? 'account',
        scopeLabel: project?.projectName ?? 'Global',
        source: 'import',
        text: memory.text,
        category: memory.category,
      },
    });
  }
  return saves;
}

export function agentFileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function importedCountLabel(count: number): string {
  if (count === 0) return 'Nothing new';
  return count === 1 ? 'Imported 1 memory' : `Imported ${count} memories`;
}
