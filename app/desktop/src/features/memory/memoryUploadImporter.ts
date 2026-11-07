import type { CloudMemoryImportExtract, CloudMemoryImportExtraction } from '@/features/cloud/cloudMemoryClient';

import type { AgentInstructionFile, MemoryImportChoice, MemoryImporter } from './memoryImport';

// Settings › Memory › Import without the Mac app: the person chooses files in
// the browser, each file's text is read here and sent to the server's model
// (`POST /v1/cloud/memory/import/extract`), which uses the Mac's import prompt
// and cap. The reply goes through the same review and `importLesson` saves as
// a Mac import; the server saves nothing on its own.

/** The Mac reads agent files up to this size, and the server accepts no more. */
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024;
/** Files one import list holds. */
export const MAX_UPLOAD_FILES = 20;
export const UPLOAD_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json'] as const;
export const UPLOAD_SOURCE = 'Chosen files';

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

const supported = (name: string) => (UPLOAD_FILE_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** A file the person chose; `File` in the browser. */
export type UploadedFile = { name: string; size: number; lastModified?: number; text(): Promise<string> };

export type UploadedFiles = {
  files: AgentInstructionFile[];
  texts: Map<string, string>;
  /** Why some chosen files were left out, empty when none were. */
  notice: string;
};

const uploadPath = (file: UploadedFile) => `upload:${file.name}:${file.size}:${file.lastModified ?? 0}`;

/**
 * Reads the chosen files that fit: a supported type, not empty, at most
 * `MAX_UPLOAD_FILE_BYTES`, and no more than `MAX_UPLOAD_FILES` with the
 * `held` ones already listed. Files already listed are read again.
 */
export async function readUploadedFiles(chosen: ReadonlyArray<UploadedFile>, held: ReadonlySet<string>, now: number = Date.now()): Promise<UploadedFiles> {
  const files: AgentInstructionFile[] = [];
  const texts = new Map<string, string>();
  const reasons = new Set<string>();
  const listed = new Set(held);
  for (const file of chosen) {
    const path = uploadPath(file);
    if (!supported(file.name)) {
      reasons.add('Choose .md, .txt, or .json files.');
      continue;
    }
    if (file.size === 0) {
      reasons.add('Empty files were skipped.');
      continue;
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      reasons.add(`Files must be ${MAX_UPLOAD_FILE_BYTES / 1024} KB or smaller.`);
      continue;
    }
    if (!listed.has(path) && listed.size >= MAX_UPLOAD_FILES) {
      reasons.add(`Import up to ${MAX_UPLOAD_FILES} files at a time.`);
      continue;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      reasons.add('Some files could not be read.');
      continue;
    }
    if (text.includes('\u0000')) {
      reasons.add('Choose .md, .txt, or .json files.');
      continue;
    }
    listed.add(path);
    texts.set(path, text);
    if (files.some((entry) => entry.path === path)) continue;
    files.push({
      path,
      root: null,
      projectName: UPLOAD_SOURCE,
      fileName: file.name,
      source: UPLOAD_SOURCE,
      size: file.size,
      modifiedAt: file.lastModified || now,
    });
  }
  return { files, texts, notice: Array.from(reasons).join(' ') };
}

/** Opens the browser's file picker; resolves with no files when it is closed. */
export function pickFilesInBrowser(): Promise<UploadedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = UPLOAD_FILE_EXTENSIONS.join(',');
    input.hidden = true;
    input.setAttribute('data-memory-import-input', '');
    const done = (files: UploadedFile[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

export type UploadImporterDeps = {
  /** The server's import model, through the memory client. */
  extract: (input: CloudMemoryImportExtract) => Promise<CloudMemoryImportExtraction>;
  pick?: () => Promise<ReadonlyArray<UploadedFile>>;
};

/**
 * The importer for a browser: no files are found, Choose files reads the
 * chosen ones here, and the server's model reads each into memories. It runs
 * on Kordi's hosted model, so it needs no provider on this device.
 */
export function createUploadMemoryImporter({ extract, pick = pickFilesInBrowser }: UploadImporterDeps): MemoryImporter {
  const texts = new Map<string, string>();
  return {
    hostedModel: true,
    discover: () => Promise.resolve([]),
    async choose(): Promise<MemoryImportChoice> {
      const chosen = await pick();
      const read = await readUploadedFiles(chosen, new Set(texts.keys()));
      read.texts.forEach((text, path) => texts.set(path, text));
      return { files: read.files, notice: read.notice };
    },
    async extract(file, existingMemories) {
      const text = texts.get(file.path);
      if (text === undefined) throw new Error('Choose this file again.');
      const { memories } = await extract({ fileName: file.fileName, text, existingMemories: [...existingMemories] });
      // The reply names this file, in the shape the shared batch parses.
      return JSON.stringify({ memories: memories.map((memory) => ({ ...memory, file: file.path })) });
    },
  };
}
