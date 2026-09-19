#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const inventoryFile = path.join(repoRoot, 'scripts/ci/check-inventory.json');

export const MANIFEST_VERSION = 1;
export const GENERATED_BY = 'scripts/ci/select-checks.mjs';

export const SHARED_PATHS = Object.freeze([
  'pnpm-lock.yaml',
  'Cargo.lock',
  'package.json',
  'Cargo.toml',
  'rust-toolchain*',
  'pnpm-workspace.yaml',
  'tsconfig*.json',
  '.github/workflows/**',
  'scripts/ci/**',
  'scripts/prepare-ci-postgres.sh',
  'scripts/test-cloud-migrations.sh',
  'scripts/prepare-tauri-sidecar-placeholders.sh',
]);

export const DOCUMENTATION_PATTERNS = Object.freeze([
  '**/*.md',
  'docs/**',
  '.github/assets/**',
  'LICENSE',
]);

export class UsageError extends Error {}

const globCache = new Map();

export function compileGlob(glob) {
  const cached = globCache.get(glob);
  if (cached) {
    return cached;
  }
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]*/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const pattern = new RegExp(`^${source}$`);
  globCache.set(glob, pattern);
  return pattern;
}

export function matchesPatterns(file, patterns) {
  return patterns.some((pattern) => compileGlob(pattern).test(file));
}

export function loadInventory(file = inventoryFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`unable to read check inventory at ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('check inventory must be a JSON object');
  }
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported check inventory version: ${parsed.version}`);
  }
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    throw new Error('check inventory must list at least one group');
  }
  const seen = new Set();
  for (const group of parsed.groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error('check inventory contains a non-object group');
    }
    if (typeof group.id !== 'string' || group.id.length === 0) {
      throw new Error('check inventory group is missing an id');
    }
    if (seen.has(group.id)) {
      throw new Error(`check inventory group id is duplicated: ${group.id}`);
    }
    seen.add(group.id);
    for (const key of ['title', 'workflow', 'command', 'runner']) {
      if (typeof group[key] !== 'string' || group[key].length === 0) {
        throw new Error(`check inventory group ${group.id} is missing ${key}`);
      }
    }
    for (const key of ['prerequisites', 'paths', 'outputs']) {
      if (!Array.isArray(group[key]) || group[key].some((entry) => typeof entry !== 'string')) {
        throw new Error(`check inventory group ${group.id} has an invalid ${key} list`);
      }
    }
    if (typeof group.always !== 'boolean' || typeof group.serial !== 'boolean') {
      throw new Error(`check inventory group ${group.id} has invalid flags`);
    }
    if (!Number.isInteger(group.timeoutMinutes) || group.timeoutMinutes <= 0) {
      throw new Error(`check inventory group ${group.id} has an invalid timeout`);
    }
  }
  return parsed;
}

export function selectGroups(groups, changedFiles, options = {}) {
  const { all = false, fallbackReason = null } = options;
  const files = [...new Set(changedFiles)].sort();
  const decisions = new Map();

  if (all) {
    for (const group of groups) {
      decisions.set(group.id, { applicable: true, reason: 'full suite requested with --all' });
    }
  } else if (fallbackReason) {
    for (const group of groups) {
      decisions.set(group.id, {
        applicable: true,
        reason: `diff unavailable (${fallbackReason}); conservative full coverage`,
      });
    }
  } else {
    const sharedMatch = files.find((file) => matchesPatterns(file, SHARED_PATHS));
    const docsOnly =
      files.length > 0 && files.every((file) => matchesPatterns(file, DOCUMENTATION_PATTERNS));
    const unknown = files.filter(
      (file) =>
        !matchesPatterns(file, SHARED_PATHS) &&
        !matchesPatterns(file, DOCUMENTATION_PATTERNS) &&
        !groups.some((group) => matchesPatterns(file, group.paths)),
    );
    for (const group of groups) {
      if (group.always) {
        decisions.set(group.id, { applicable: true, reason: 'always runs for every change' });
      } else if (sharedMatch) {
        decisions.set(group.id, {
          applicable: true,
          reason: `shared path changed: ${sharedMatch}`,
        });
      } else if (docsOnly) {
        decisions.set(group.id, { applicable: false, reason: 'documentation-only change' });
      } else if (unknown.length > 0) {
        decisions.set(group.id, {
          applicable: true,
          reason: `unrecognized path: ${unknown[0]}; conservative full coverage`,
        });
      } else {
        const match = files.find((file) => matchesPatterns(file, group.paths));
        decisions.set(
          group.id,
          match
            ? { applicable: true, reason: `changed path matched: ${match}` }
            : { applicable: false, reason: 'no changed path matched this group' },
        );
      }
    }
  }

  return groups.map((group) => ({
    id: group.id,
    applicable: decisions.get(group.id).applicable,
    reason: decisions.get(group.id).reason,
  }));
}

function validateSha(value) {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new UsageError(`expected a hexadecimal commit SHA, received: ${value}`);
  }
  return value.toLowerCase();
}

export function parseSelectionArgs(argv) {
  const options = {
    base: undefined,
    head: undefined,
    all: false,
    changedFiles: undefined,
    out: undefined,
    json: false,
    run: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${argument} requires a value`);
      }
      index += 1;
      return next;
    };
    if (argument === '--base') {
      options.base = validateSha(value());
    } else if (argument === '--head') {
      options.head = validateSha(value());
    } else if (argument === '--all') {
      options.all = true;
    } else if (argument === '--changed-files') {
      options.changedFiles = value();
    } else if (argument === '--out') {
      options.out = value();
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--run') {
      options.run = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new UsageError(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export function readChangedFiles(file) {
  let contents;
  try {
    contents = readFileSync(path.resolve(process.cwd(), file), 'utf8');
  } catch (error) {
    throw new UsageError(`unable to read --changed-files file ${file}: ${error.message}`);
  }
  const entries = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.includes('\0')) {
      throw new UsageError('changed-files entries must not contain NUL bytes');
    }
    if (path.isAbsolute(line)) {
      throw new UsageError(`changed-files entries must be repository-relative: ${line}`);
    }
    if (line.split('/').includes('..')) {
      throw new UsageError(`changed-files entries must not contain parent-directory segments: ${line}`);
    }
    entries.push(line);
  }
  if (entries.length === 0) {
    throw new UsageError(`changed-files list at ${file} is empty`);
  }
  return entries;
}

export function fallbackManifest(groups, base, head, reason) {
  return {
    version: MANIFEST_VERSION,
    base,
    head,
    mode: 'diff',
    fallback: true,
    generatedBy: GENERATED_BY,
    groups: selectGroups(groups, [], { fallbackReason: reason }),
  };
}

export function renderSummary(manifest, changedFiles) {
  const lines = [];
  lines.push(`Comparison: ${manifest.base}...${manifest.head} (mode: ${manifest.mode})`);
  if (manifest.fallback) {
    lines.push('Fallback: yes (all groups marked applicable)');
  }
  lines.push(`Changed paths: ${changedFiles.length}`);
  for (const file of changedFiles.slice(0, 20)) {
    lines.push(`  ${file}`);
  }
  if (changedFiles.length > 20) {
    lines.push(`  ... and ${changedFiles.length - 20} more`);
  }
  const applicable = manifest.groups.filter((group) => group.applicable);
  const notApplicable = manifest.groups.filter((group) => !group.applicable);
  lines.push('Applicable checks:');
  if (applicable.length === 0) {
    lines.push('  none');
  }
  for (const entry of applicable) {
    lines.push(`  ${entry.id}: ${entry.reason}`);
  }
  if (notApplicable.length > 0) {
    lines.push('Not applicable checks:');
    for (const entry of notApplicable) {
      lines.push(`  ${entry.id}: ${entry.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
