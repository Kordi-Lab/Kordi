#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function normalize(filePath) {
  return path.resolve(filePath);
}

function isWithin(candidate, root) {
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rootForTarget(targetPath, worktreesDir) {
  const relative = path.relative(normalize(worktreesDir), normalize(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const [rootName] = relative.split(path.sep);
  if (!rootName) {
    return null;
  }
  return path.join(normalize(worktreesDir), rootName);
}

export async function findTargetDirs(worktreesDir) {
  const targets = [];
  const root = normalize(worktreesDir);

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === 'node_modules') {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.name === 'target') {
        targets.push(child);
        continue;
      }
      await walk(child);
    }
  }

  await walk(root);
  return targets.sort();
}

export async function buildCleanupPlan({ worktreesDir, activeRoots = [], keepRoots = [] }) {
  const targetDirs = await findTargetDirs(worktreesDir);
  const normalizedActiveRoots = activeRoots.map(normalize);
  const normalizedKeepRoots = keepRoots.map(normalize);
  const deleteCandidates = [];
  const kept = [];

  for (const target of targetDirs) {
    const worktreeRoot = rootForTarget(target, worktreesDir);
    if (!worktreeRoot) {
      kept.push({ path: target, reason: 'outside worktrees dir' });
      continue;
    }

    if (normalizedKeepRoots.some((root) => isWithin(target, root))) {
      kept.push({ path: target, reason: 'kept root' });
      continue;
    }

    if (normalizedActiveRoots.some((root) => isWithin(target, root))) {
      kept.push({ path: target, reason: 'active root' });
      continue;
    }

    deleteCandidates.push({ path: target, reason: 'inactive worktree target' });
  }

  return { deleteCandidates, kept };
}

export async function deleteTargets(candidates, { delete: shouldDelete = false } = {}) {
  if (!shouldDelete) {
    return { deleted: [] };
  }

  const deleted = [];
  for (const candidate of candidates) {
    await rm(candidate.path, { recursive: true, force: true });
    deleted.push(candidate.path);
  }
  return { deleted };
}

export function extractWorktreeRootsFromText(text, worktreesDir) {
  const roots = new Set();
  const root = normalize(worktreesDir);
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}/([^\\s\\0"']+)`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [rootName] = match[1].split('/');
    if (rootName) {
      roots.add(path.join(root, rootName));
    }
  }
  return [...roots].sort();
}

function runText(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return '';
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export function discoverActiveRoots(worktreesDir) {
  const roots = new Set();
  const sources = [
    runText('ps', ['-axo', 'args=']),
    runText('lsof', ['-nP', '-d', 'cwd']),
    runText('lsof', ['-nP']),
  ];

  for (const source of sources) {
    for (const root of extractWorktreeRootsFromText(source, worktreesDir)) {
      roots.add(root);
    }
  }

  return [...roots].sort();
}

function defaultWorktreesDir() {
  if (process.env.KORDI_WORKTREES_DIR) {
    return normalize(process.env.KORDI_WORKTREES_DIR);
  }

  const parent = path.dirname(repoRoot);
  if (path.basename(parent).endsWith('-worktrees')) {
    return parent;
  }

  return path.join(parent, `${path.basename(repoRoot)}-worktrees`);
}

function parseArgs(argv) {
  const options = {
    delete: false,
    worktreesDir: defaultWorktreesDir(),
    keepRoots: [],
    discoverActive: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--delete') {
      options.delete = true;
    } else if (arg === '--dry-run') {
      options.delete = false;
    } else if (arg === '--worktrees-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--worktrees-dir requires a path');
      }
      options.worktreesDir = normalize(value);
      index += 1;
    } else if (arg === '--keep-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--keep-root requires a worktree name or path');
      }
      options.keepRoots.push(value);
      index += 1;
    } else if (arg === '--skip-active-discovery') {
      options.discoverActive = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.keepRoots = options.keepRoots.map((root) => {
    if (path.isAbsolute(root)) {
      return normalize(root);
    }
    return path.join(options.worktreesDir, root);
  });

  return options;
}

function formatSize(kib) {
  if (kib >= 1024 * 1024) {
    return `${(kib / 1024 / 1024).toFixed(2)} GiB`;
  }
  if (kib >= 1024) {
    return `${(kib / 1024).toFixed(1)} MiB`;
  }
  return `${kib} KiB`;
}

function sizeKiB(targetPath) {
  const result = spawnSync('du', ['-sk', targetPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return 0;
  }
  return Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '0', 10) || 0;
}

function printHelp() {
  console.log(`Usage: node scripts/clean-inactive-worktree-targets.mjs [options]\n\nOptions:\n  --dry-run                 Show what would be deleted (default)\n  --delete                  Delete inactive target directories\n  --worktrees-dir <path>    Worktree parent directory (default: ${defaultWorktreesDir()})\n  --keep-root <name|path>   Keep a worktree root; can be repeated\n  --skip-active-discovery   Do not inspect ps/lsof for active roots\n  -h, --help                Show this help\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  const activeRoots = options.discoverActive ? discoverActiveRoots(options.worktreesDir) : [];
  const keepRoots = [...options.keepRoots];
  if (isWithin(repoRoot, options.worktreesDir)) {
    keepRoots.push(repoRoot);
  }

  const plan = await buildCleanupPlan({
    worktreesDir: options.worktreesDir,
    activeRoots,
    keepRoots,
  });

  let totalKiB = 0;
  console.log(`${options.delete ? 'Deleting' : 'Dry run: would delete'} ${plan.deleteCandidates.length} inactive target dirs under ${options.worktreesDir}`);
  for (const candidate of plan.deleteCandidates) {
    const kib = sizeKiB(candidate.path);
    totalKiB += kib;
    console.log(`  ${formatSize(kib).padStart(10)}  ${candidate.path}`);
  }
  console.log(`Estimated reclaimable: ${formatSize(totalKiB)}`);

  if (plan.kept.length > 0) {
    console.log('\nKept target dirs:');
    for (const entry of plan.kept) {
      console.log(`  ${entry.path} (${entry.reason})`);
    }
  }

  const result = await deleteTargets(plan.deleteCandidates, { delete: options.delete });
  if (options.delete) {
    console.log(`\nDeleted ${result.deleted.length} inactive target dirs.`);
  } else {
    console.log('\nNo files deleted. Re-run with --delete to remove the listed directories.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
