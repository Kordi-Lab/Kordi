#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GENERATED_BY,
  MANIFEST_VERSION,
  UsageError,
  compileGlob,
  fallbackManifest,
  loadInventory,
  matchesPatterns,
  parseSelectionArgs,
  readChangedFiles,
  renderSummary,
  selectGroups,
  SHARED_PATHS,
  DOCUMENTATION_PATTERNS,
} from './selection.mjs';

export {
  UsageError,
  compileGlob,
  loadInventory,
  matchesPatterns,
  renderSummary,
  selectGroups,
  SHARED_PATHS,
  DOCUMENTATION_PATTERNS,
};

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runCheckScript = path.join(repoRoot, 'scripts/ci/run-check.mjs');

function runGit(args) {
  return spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
}

function resolveRef(ref) {
  const result = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.status !== 0) {
    return null;
  }
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

function parseNameStatus(output) {
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) {
      if (parts[1]) {
        files.push(parts[1]);
      }
      if (parts[2]) {
        files.push(parts[2]);
      }
    } else if (parts[1]) {
      files.push(parts[1]);
    }
  }
  return files;
}

function collectDiff({ base, head, mergeBase }) {
  const range = mergeBase ? `${base}...${head}` : base;
  const result = runGit(['diff', '--name-status', '-M', range]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff ${range} failed`);
  }
  const files = parseNameStatus(result.stdout);
  if (!mergeBase) {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard']);
    if (untracked.status === 0) {
      files.push(...untracked.stdout.split(/\r?\n/).filter((line) => line.length > 0));
    }
  }
  return [...new Set(files)].sort();
}

export function buildManifest(inventory, options) {
  const groups = inventory.groups;
  const base = options.base ?? 'unknown';
  const head = options.head ?? 'unknown';
  if (options.all) {
    return {
      manifest: {
        version: MANIFEST_VERSION,
        base,
        head,
        mode: 'all',
        fallback: false,
        generatedBy: GENERATED_BY,
        groups: selectGroups(groups, [], { all: true }),
      },
      fallbackReason: null,
      changedFiles: [],
    };
  }
  if (options.changedFiles !== undefined) {
    const files = readChangedFiles(options.changedFiles);
    return {
      manifest: {
        version: MANIFEST_VERSION,
        base,
        head,
        mode: 'diff',
        fallback: false,
        generatedBy: GENERATED_BY,
        groups: selectGroups(groups, files),
      },
      fallbackReason: null,
      changedFiles: files,
    };
  }

  const headSha = resolveRef(options.head ?? 'HEAD');
  let baseSha = null;
  const mergeBase = Boolean(options.base && options.head);
  if (options.base) {
    baseSha = resolveRef(options.base);
  } else if (headSha) {
    for (const ref of ['origin/main', 'main']) {
      const result = runGit(['merge-base', headSha, ref]);
      if (result.status === 0 && /^[0-9a-f]{40,64}$/.test(result.stdout.trim())) {
        baseSha = result.stdout.trim();
        break;
      }
    }
    if (!baseSha) {
      const parent = runGit(['rev-parse', `${headSha}^`]);
      if (parent.status === 0 && /^[0-9a-f]{40,64}$/.test(parent.stdout.trim())) {
        baseSha = parent.stdout.trim();
      }
    }
  }

  if (!baseSha || !headSha) {
    const reason = options.base
      ? `unable to resolve revision ${options.base}`
      : 'unable to determine a comparison base';
    return {
      manifest: fallbackManifest(groups, base, head, reason),
      fallbackReason: reason,
      changedFiles: [],
    };
  }

  try {
    const files = collectDiff({ base: baseSha, head: headSha, mergeBase });
    return {
      manifest: {
        version: MANIFEST_VERSION,
        base: baseSha,
        head: headSha,
        mode: 'diff',
        fallback: false,
        generatedBy: GENERATED_BY,
        groups: selectGroups(groups, files),
      },
      fallbackReason: null,
      changedFiles: files,
    };
  } catch (error) {
    return {
      manifest: fallbackManifest(groups, baseSha, headSha, error.message),
      fallbackReason: error.message,
      changedFiles: [],
    };
  }
}

function usage() {
  return [
    'Usage: node scripts/ci/select-checks.mjs [options]',
    '',
    'Options:',
    '  --base <sha>            base revision for the comparison',
    '  --head <sha>            head revision for the comparison',
    '  --all                   mark every group applicable',
    '  --changed-files <path>  read a newline-separated changed-file list instead of git',
    '  --out <path>            write the manifest JSON to a file',
    '  --json                  print the manifest JSON instead of a summary',
    '  --run                   run applicable groups through scripts/ci/run-check.mjs',
    '  --help                  show this message',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSelectionArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`select-checks: ${error.message}`);
      console.error('select-checks: run with --help for usage');
      return 1;
    }
    throw error;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let inventory;
  let result;
  try {
    inventory = loadInventory();
    result = buildManifest(inventory, options);
  } catch (error) {
    console.error(`select-checks: ${error.message}`);
    return 1;
  }

  if (options.out) {
    try {
      mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      writeFileSync(options.out, `${JSON.stringify(result.manifest, null, 2)}\n`);
    } catch (error) {
      console.error(`select-checks: unable to write ${options.out}: ${error.message}`);
      return 1;
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
  } else {
    process.stdout.write(renderSummary(result.manifest, result.changedFiles));
  }

  if (result.fallbackReason) {
    console.error(
      `select-checks: warning: ${result.fallbackReason}; all groups marked applicable`,
    );
  }

  if (options.run) {
    for (const entry of result.manifest.groups.filter((group) => group.applicable)) {
      const run = spawnSync(process.execPath, [runCheckScript, entry.id], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      if (run.status !== 0) {
        return run.status ?? 1;
      }
    }
  }
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  process.exitCode = main();
}
