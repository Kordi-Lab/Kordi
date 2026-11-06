import type { AgentInstructionFile, MemoryImportChoice, MemoryImporter } from './memoryImport';
import { LESSON_MAX_CHARS } from './memoryModel';

// Settings › Memory › Import without the Mac app: the person chooses files in
// the browser, each file's text is read here, and every memory found goes
// through the same review and `importLesson` saves as a Mac import. Nothing is
// sent anywhere else, and no model reads the file: list items and paragraphs
// become memories as written.

/** The Mac reads agent files up to this size (`MAX_AGENT_FILE_BYTES`). */
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024;
/** Files one import list holds. */
export const MAX_UPLOAD_FILES = 20;
/** Memories one file adds; each is one save. */
export const MAX_UPLOAD_MEMORIES_PER_FILE = 50;
export const UPLOAD_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json'] as const;
export const UPLOAD_SOURCE = 'Chosen files';

type UploadMemory = { text: string; category?: string; scope: 'project' | 'global' };

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

const supported = (name: string) => (UPLOAD_FILE_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** Splits text over the memory length at sentence ends, and at words when one sentence is too long. */
function withinLimit(text: string): string[] {
  if (text.length <= LESSON_MAX_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const parts: string[] = [];
  let current = '';
  const push = (piece: string) => {
    const next = current ? `${current} ${piece}` : piece;
    if (next.length <= LESSON_MAX_CHARS) {
      current = next;
      return;
    }
    if (current) parts.push(current);
    current = piece;
    while (current.length > LESSON_MAX_CHARS) {
      const cut = current.lastIndexOf(' ', LESSON_MAX_CHARS);
      const at = cut > 0 ? cut : LESSON_MAX_CHARS;
      parts.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  };
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed) push(trimmed);
  }
  if (current) parts.push(current);
  return parts;
}

/** Plain text of one Markdown line: links keep their label; bold, italics, and quote marks go. */
function plainLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^>\s?/, '')
    .trim();
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/** The category a Claude Code memory file's frontmatter `type` gives, or null to skip the file. */
function frontmatterCategory(type: string | null): { category: string; scope: UploadMemory['scope'] } | null | undefined {
  if (type === 'reference') return null;
  if (type === 'user') return { category: 'general_preferences', scope: 'global' };
  if (type === 'feedback') return { category: 'hcp-custom:task_lessons', scope: 'project' };
  if (type === 'project') return { category: 'work_context', scope: 'project' };
  return undefined;
}

/** Memories in a Markdown or text file: each list item and each paragraph, without headings, code, or tables. */
export function textFileMemories(text: string): UploadMemory[] {
  let body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let kind: { category: string; scope: UploadMemory['scope'] } = { category: 'hcp-custom:task_lessons', scope: 'project' };
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (frontmatter) {
    body = body.slice(frontmatter[0].length);
    const type = /^type:\s*["']?([\w-]+)/m.exec(frontmatter[1])?.[1]?.toLowerCase() ?? null;
    const chosen = frontmatterCategory(type);
    if (chosen === null) return [];
    if (chosen) kind = chosen;
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const joined = current.join(' ').replace(/\s+/g, ' ').trim();
    current = [];
    // A lead-in such as "Rules:" introduces the list after it.
    if (joined && !/:$/.test(joined)) blocks.push(joined);
  };
  for (const raw of body.split('\n')) {
    const fenceMark = /^\s*(```|~~~)/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark === fence) fence = null;
      continue;
    }
    if (fenceMark) {
      flush();
      fence = fenceMark;
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim() || /^\s*#{1,6}\s/.test(line) || /^\s*\|/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*<\/?[a-z][^>]*>\s*$/i.test(line)) {
      flush();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      current.push(plainLine(item[2]));
    } else {
      current.push(plainLine(line));
    }
  }
  flush();
  return blocks.flatMap((block) => withinLimit(block)).map((memory) => ({ text: memory, ...kind }));
}

function jsonEntryMemory(entry: unknown): UploadMemory | null {
  if (typeof entry === 'string') return { text: entry, scope: 'global' };
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const text = [record.text, record.content, record.memory].find((value): value is string => typeof value === 'string');
  if (!text) return null;
  return {
    text,
    category: typeof record.category === 'string' ? record.category : undefined,
    scope: record.scope === 'project' ? 'project' : 'global',
  };
}

/** Memories in a JSON file: a list of texts or `{ text }` objects, alone or under `memories`. */
export function jsonFileMemories(text: string): UploadMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : null;
  if (!entries) throw new Error('This file has no list of memories.');
  return entries.map(jsonEntryMemory).filter((memory): memory is UploadMemory => memory !== null);
}

/** The import reply for one chosen file, in the shape `parseMemoryImportReply` reads. */
export function uploadedFileReply(file: Pick<AgentInstructionFile, 'path' | 'fileName'>, text: string): string {
  const memories = extensionOf(file.fileName) === '.json' ? jsonFileMemories(text) : textFileMemories(text);
  return JSON.stringify({ memories: memories.slice(0, MAX_UPLOAD_MEMORIES_PER_FILE).map((memory) => ({ ...memory, file: file.path })) });
}

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

/**
 * The importer for a browser: no files are found, and Choose files reads the
 * chosen ones here. Reading needs no model, provider, or import run.
 */
export function createUploadMemoryImporter(pick: () => Promise<ReadonlyArray<UploadedFile>> = pickFilesInBrowser): MemoryImporter {
  const texts = new Map<string, string>();
  return {
    readsLocally: true,
    memoriesPerFile: MAX_UPLOAD_MEMORIES_PER_FILE,
    discover: () => Promise.resolve([]),
    async choose(): Promise<MemoryImportChoice> {
      const chosen = await pick();
      const read = await readUploadedFiles(chosen, new Set(texts.keys()));
      read.texts.forEach((text, path) => texts.set(path, text));
      return { files: read.files, notice: read.notice };
    },
    extract(file) {
      const text = texts.get(file.path);
      if (text === undefined) return Promise.reject(new Error('Choose this file again.'));
      try {
        return Promise.resolve(uploadedFileReply(file, text));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Could not read this file.'));
      }
    },
  };
}
