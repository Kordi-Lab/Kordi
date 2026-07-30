#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXTENSIONS,
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_PATH_PREFIXES,
} from './report-overlong-files.mjs';

export const SOURCE_CATEGORIES = ['production', 'test', 'generated'];
export const AUDIT_THRESHOLDS = [500, 1000, 1500];

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

export function classifySourcePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');

  if (
    DEFAULT_SKIP_PATH_PREFIXES.some((prefix) => (
      normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    ))
    || segments.some((segment) => DEFAULT_SKIP_DIRS.has(segment))
    || segments.includes('generated')
    || segments.includes('vendor')
    || /(?:^|\/)[^/]+\.generated\.[^/]+$/u.test(normalized)
  ) {
    return 'generated';
  }

  const basename = segments.at(-1) ?? '';
  if (
    segments.some((segment) => matchesTestDirectory(segment))
    || /\.(?:test|spec)\.[^.]+$/u.test(basename)
    || /(?:^|_)(?:test|tests)\.rs$/u.test(basename)
  ) {
    return 'test';
  }

  return 'production';
}

function matchesTestDirectory(segment) {
  return segment === 'test'
    || segment === 'tests'
    || segment === '__tests__'
    || segment === 'test_support'
    || segment === 'fixtures';
}

function emptyCategorySummary() {
  return {
    fileCount: 0,
    lineCount: 0,
    hotspots: Object.fromEntries(AUDIT_THRESHOLDS.map((threshold) => [threshold, 0])),
  };
}

export function summarizeSourceInventory(entries, { minLines = 500 } = {}) {
  const categories = Object.fromEntries(
    SOURCE_CATEGORIES.map((category) => [category, emptyCategorySummary()]),
  );
  const hotspots = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRelativePath(entry.path);
    if (!DEFAULT_EXTENSIONS.has(path.extname(normalizedPath))) continue;

    const category = classifySourcePath(normalizedPath);
    const lineCount = countLines(entry.source);
    const summary = categories[category];
    summary.fileCount += 1;
    summary.lineCount += lineCount;
    for (const threshold of AUDIT_THRESHOLDS) {
      if (lineCount >= threshold) summary.hotspots[threshold] += 1;
    }
    if (lineCount >= minLines) {
      hotspots.push({ category, lineCount, path: normalizedPath });
    }
  }

  hotspots.sort((left, right) => (
    right.lineCount - left.lineCount
    || left.category.localeCompare(right.category)
    || left.path.localeCompare(right.path)
  ));

  return {
    schemaVersion: 1,
    sourceScope: 'git-tracked',
    minLines,
    categories,
    hotspots,
  };
}

export async function auditTrackedSources(root = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(root);
  const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
    cwd: resolvedRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const sourcePaths = trackedPaths.filter((relativePath) => (
    DEFAULT_EXTENSIONS.has(path.extname(relativePath))
  ));
  const entries = await Promise.all(sourcePaths.map(async (relativePath) => ({
    path: relativePath,
    source: await readFile(path.join(resolvedRoot, relativePath), 'utf8'),
  })));
  return summarizeSourceInventory(entries, options);
}

export function formatMaintainabilityAudit(report, { limit = 40 } = {}) {
  const header = [
    'Maintainability audit (git-tracked source)',
    'category      files       lines    >=500   >=1000   >=1500',
  ];
  const categoryRows = SOURCE_CATEGORIES.map((category) => {
    const summary = report.categories[category];
    return [
      category.padEnd(12),
      String(summary.fileCount).padStart(6),
      String(summary.lineCount).padStart(11),
      String(summary.hotspots[500]).padStart(8),
      String(summary.hotspots[1000]).padStart(9),
      String(summary.hotspots[1500]).padStart(9),
    ].join('');
  });
  const hotspotRows = report.hotspots.slice(0, limit).map((row) => (
    `${String(row.lineCount).padStart(5)} ${row.category.padEnd(10)} ${row.path}`
  ));

  return [
    ...header,
    ...categoryRows,
    '',
    `Hotspots at or above ${report.minLines} lines (showing ${hotspotRows.length} of ${report.hotspots.length})`,
    ...hotspotRows,
  ].join('\n');
}

export function parseMaintainabilityAuditArgs(argv) {
  const options = {
    root: process.cwd(),
    minLines: 500,
    limit: 40,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--root' || arg === '--min-lines' || arg === '--limit') {
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
  node scripts/report-maintainability-audit.mjs [--root <path>] [--min-lines <n>] [--limit <n>] [--json]

Reports git-tracked source inventory and hotspots separately for production,
test, and generated code.`);
}

async function main() {
  const options = parseMaintainabilityAuditArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await auditTrackedSources(options.root, { minLines: options.minLines });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMaintainabilityAudit(report, { limit: options.limit }));
  }
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
