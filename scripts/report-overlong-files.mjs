#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.superpowers',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

export const DEFAULT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.js',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

export const DEFAULT_SKIP_PATH_PREFIXES = [
  'app/desktop/src-tauri/gen/',
];

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function shouldSkipRelativePath(relativePath, skipPathPrefixes) {
  const normalized = normalizeRelativePath(relativePath);
  return skipPathPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

async function walkSourceFiles(root, {
  extensions,
  skipDirs,
  skipPathPrefixes,
  relativeDir = '',
} = {}) {
  const dir = path.join(root, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      const childRelativeDir = path.join(relativeDir, entry.name);
      if (shouldSkipRelativePath(childRelativeDir, skipPathPrefixes)) continue;
      files.push(...await walkSourceFiles(root, {
        extensions,
        skipDirs,
        skipPathPrefixes,
        relativeDir: childRelativeDir,
      }));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!extensions.has(path.extname(entry.name))) continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (shouldSkipRelativePath(relativePath, skipPathPrefixes)) continue;
    files.push(relativePath);
  }

  return files;
}

export async function scanOverlongFiles(root = process.cwd(), {
  minLines = 500,
  extensions = DEFAULT_EXTENSIONS,
  skipDirs = DEFAULT_SKIP_DIRS,
  skipPathPrefixes = DEFAULT_SKIP_PATH_PREFIXES,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const files = await walkSourceFiles(resolvedRoot, {
    extensions,
    skipDirs,
    skipPathPrefixes,
  });
  const rows = [];

  for (const relativePath of files) {
    const text = await readFile(path.join(resolvedRoot, relativePath), 'utf8');
    const lineCount = countLines(text);
    if (lineCount >= minLines) {
      rows.push({
        lineCount,
        path: normalizeRelativePath(relativePath),
      });
    }
  }

  return rows.sort((left, right) => (
    right.lineCount - left.lineCount || left.path.localeCompare(right.path)
  ));
}

export function formatOverlongFileRows(rows) {
  return rows
    .map((row) => `${String(row.lineCount).padStart(4, ' ')} ${row.path}`)
    .join('\n');
}

export function parseOverlongFileArgs(argv) {
  const options = {
    root: process.cwd(),
    minLines: 500,
    limit: 60,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--min-lines' || arg === '--limit' || arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === '--root') {
        options.root = path.resolve(process.cwd(), value);
      } else {
        const number = Number.parseInt(value, 10);
        if (!Number.isInteger(number) || number <= 0) {
          throw new Error(`Invalid ${arg}: ${value}`);
        }
        if (arg === '--min-lines') options.minLines = number;
        if (arg === '--limit') options.limit = number;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/report-overlong-files.mjs [--root <path>] [--min-lines <n>] [--limit <n>] [--json]

Reports source files at or above the line-count threshold used for maintainability planning.
Generated/build/vendor paths are skipped by default.`);
}

async function main() {
  const options = parseOverlongFileArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const rows = await scanOverlongFiles(options.root, { minLines: options.minLines });
  const limitedRows = rows.slice(0, options.limit);
  if (options.json) {
    console.log(JSON.stringify(limitedRows, null, 2));
    return;
  }
  console.log(formatOverlongFileRows(limitedRows));
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
