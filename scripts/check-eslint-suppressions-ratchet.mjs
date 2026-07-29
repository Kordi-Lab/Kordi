#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gitOutput,
  readTextAtCommit,
  resolveGitComparison,
} from './git-ratchet.mjs';

export const DEFAULT_SUPPRESSIONS_PATH = 'app/desktop/eslint-suppressions.json';

export function parseSuppressions(value, label = 'ESLint suppressions') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const counts = new Map();
  for (const [filePath, rules] of Object.entries(value)) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      throw new Error(`${label} entry ${filePath} must be an object`);
    }
    for (const [ruleName, entry] of Object.entries(rules)) {
      const count = entry?.count;
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`${label} entry ${filePath} :: ${ruleName} has an invalid count`);
      }
      counts.set(`${filePath}\0${ruleName}`, {
        count,
        filePath,
        ruleName,
      });
    }
  }
  return counts;
}

export function evaluateSuppressionGrowth(current, previous) {
  const violations = [];
  for (const entry of current.values()) {
    const priorCount = previous.get(`${entry.filePath}\0${entry.ruleName}`)?.count ?? 0;
    if (entry.count > priorCount) {
      violations.push({
        ...entry,
        previousCount: priorCount,
        addedCount: entry.count - priorCount,
      });
    }
  }
  return violations.sort((left, right) => (
    left.filePath.localeCompare(right.filePath)
    || left.ruleName.localeCompare(right.ruleName)
  ));
}

export function parseSuppressionRatchetArgs(argv) {
  const options = {
    diffRange: undefined,
    suppressionsPath: DEFAULT_SUPPRESSIONS_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--suppressions') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --suppressions');
      options.suppressionsPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    if (options.diffRange) throw new Error(`Unexpected argument: ${arg}`);
    options.diffRange = arg;
  }

  return options;
}

export function formatSuppressionGrowth(violations) {
  return [
    'ESLint suppression debt may shrink but must not grow:',
    ...violations.map((violation) => (
      `  ${violation.filePath} :: ${violation.ruleName}: `
      + `${violation.previousCount} -> ${violation.count} (+${violation.addedCount})`
    )),
    'Fix the new lint finding instead of regenerating the suppression baseline.',
  ].join('\n');
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-eslint-suppressions-ratchet.mjs [<git-diff-range>] [--suppressions <path>]

Fails when an existing ESLint suppression count grows or a new suppression is added.
The first checked-in baseline is allowed when the comparison commit has no baseline.`);
}

async function main() {
  const options = parseSuppressionRatchetArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const repoRoot = gitOutput(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const relativePath = options.suppressionsPath.split(path.sep).join('/');
  const current = parseSuppressions(
    JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8')),
    'Current ESLint suppressions',
  );
  const comparison = resolveGitComparison(repoRoot, options.diffRange, {
    defaultBaseRef: process.env.KORDI_ESLINT_BASE || 'origin/main',
  });
  const previousSource = readTextAtCommit(repoRoot, comparison.baseCommit, relativePath);
  if (previousSource === undefined) {
    console.log(
      `ESLint suppression ratchet initialized with ${current.size} file/rule entr${current.size === 1 ? 'y' : 'ies'}.`,
    );
    return;
  }

  const previous = parseSuppressions(
    JSON.parse(previousSource),
    `ESLint suppressions at ${comparison.baseCommit}`,
  );
  const violations = evaluateSuppressionGrowth(current, previous);
  if (violations.length > 0) {
    console.error(formatSuppressionGrowth(violations));
    process.exitCode = 1;
    return;
  }

  console.log(
    `ESLint suppression ratchet passed (${current.size} current entries; no debt growth).`,
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
