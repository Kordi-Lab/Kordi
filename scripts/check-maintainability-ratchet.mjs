#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gitOutput,
  readTextAtCommit,
  resolveGitComparison,
} from './git-ratchet.mjs';
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_PATH_PREFIXES,
} from './report-overlong-files.mjs';

export const DEFAULT_MAX_LINES = 500;

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

export function countSourceLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

export function isScannableSourcePath(relativePath, {
  extensions = DEFAULT_EXTENSIONS,
  skipDirs = DEFAULT_SKIP_DIRS,
  skipPathPrefixes = DEFAULT_SKIP_PATH_PREFIXES,
} = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (!extensions.has(path.extname(normalized))) return false;
  if (normalized.split('/').some((segment) => skipDirs.has(segment))) return false;
  return !skipPathPrefixes.some((prefix) => (
    normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
  ));
}

export function evaluateMaintainabilityChanges(changes, {
  maxLines = DEFAULT_MAX_LINES,
} = {}) {
  return changes
    .filter(({ currentLineCount, previousLineCount }) => (
      currentLineCount >= maxLines && currentLineCount > previousLineCount
    ))
    .map((change) => ({
      ...change,
      addedLineCount: change.currentLineCount - change.previousLineCount,
    }))
    .sort((left, right) => (
      right.currentLineCount - left.currentLineCount
      || left.path.localeCompare(right.path)
    ));
}

export function parseMaintainabilityArgs(argv) {
  const options = {
    diffRange: undefined,
    maxLines: DEFAULT_MAX_LINES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--max-lines') {
      const value = argv[index + 1];
      const number = Number.parseInt(value ?? '', 10);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`Invalid --max-lines: ${value ?? ''}`);
      }
      options.maxLines = number;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    if (options.diffRange) throw new Error(`Unexpected argument: ${arg}`);
    options.diffRange = arg;
  }

  return options;
}

function parseChangedPaths(raw) {
  const fields = raw.split('\0');
  const changes = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (!status) continue;

    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index];
      const currentPath = fields[index + 1];
      index += 2;
      changes.push({ currentPath, previousPath, status: status[0] });
      continue;
    }

    const currentPath = fields[index];
    index += 1;
    changes.push({
      currentPath,
      previousPath: status === 'A' ? undefined : currentPath,
      status: status[0],
    });
  }

  return changes;
}

export async function collectChangedSourceMetrics(repoRoot, diffRange) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedRange = resolveGitComparison(resolvedRoot, diffRange, {
    defaultBaseRef: process.env.KORDI_MAINTAINABILITY_BASE || 'origin/main',
  });
  const rawChanges = gitOutput(resolvedRoot, [
    'diff',
    '--name-status',
    '--diff-filter=ACMR',
    '--find-renames',
    '-z',
    resolvedRange.diffRange,
  ]);
  const changedPaths = parseChangedPaths(rawChanges);
  if (!diffRange) {
    const trackedPaths = new Set(changedPaths.map(({ currentPath }) => currentPath));
    const untrackedPaths = gitOutput(resolvedRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]).split('\0').filter(Boolean);
    for (const currentPath of untrackedPaths) {
      if (!trackedPaths.has(currentPath)) {
        changedPaths.push({ currentPath, previousPath: undefined, status: 'A' });
      }
    }
  }
  const sourceChanges = changedPaths
    .filter(({ currentPath }) => isScannableSourcePath(currentPath));
  const metrics = [];

  for (const { currentPath, previousPath, status } of sourceChanges) {
    const normalizedPath = normalizeRelativePath(currentPath);
    const [currentSource, previousSource] = await Promise.all([
      readFile(path.join(resolvedRoot, currentPath), 'utf8'),
      Promise.resolve(
        readTextAtCommit(
          resolvedRoot,
          resolvedRange.baseCommit,
          previousPath ? normalizeRelativePath(previousPath) : undefined,
        ) ?? '',
      ),
    ]);
    metrics.push({
      path: normalizedPath,
      previousPath: previousPath ? normalizeRelativePath(previousPath) : undefined,
      status,
      currentLineCount: countSourceLines(currentSource),
      previousLineCount: countSourceLines(previousSource),
    });
  }

  return metrics;
}

export function formatMaintainabilityViolations(violations, maxLines = DEFAULT_MAX_LINES) {
  const rows = violations.map((violation) => {
    const growth = `+${violation.addedLineCount}`;
    return `  ${violation.path}: ${violation.previousLineCount} -> ${violation.currentLineCount} lines (${growth})`;
  });
  return [
    `Changed source files may not create or grow files at ${maxLines}+ lines.`,
    ...rows,
    'Split the new responsibility into a focused module, or reduce the hotspot before adding code.',
  ].join('\n');
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-maintainability-ratchet.mjs [<git-diff-range>] [--max-lines <n>]

Fails when a changed source file reaches the threshold or an existing hotspot grows.
Without a range, compares the working tree with the merge base of origin/main.`);
}

async function main() {
  const options = parseMaintainabilityArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const repoRoot = gitOutput(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const changes = await collectChangedSourceMetrics(repoRoot, options.diffRange);
  const violations = evaluateMaintainabilityChanges(changes, {
    maxLines: options.maxLines,
  });
  if (violations.length > 0) {
    console.error(formatMaintainabilityViolations(violations, options.maxLines));
    process.exitCode = 1;
    return;
  }

  console.log(
    `Maintainability ratchet passed for ${changes.length} changed source file${changes.length === 1 ? '' : 's'} `
    + `(no new growth at ${options.maxLines}+ lines).`,
  );
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
