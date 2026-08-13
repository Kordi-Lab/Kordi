#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SAFE_CARGO_CACHE_PARTS = [
  ['debug', 'deps'],
  ['debug', 'incremental'],
  ['debug', 'build'],
  ['debug', '.fingerprint'],
];
const SAFE_BUILD_DIR_PATTERN = /^(?:cargo(?:-|$)|ios(?:-|$)|macos(?:-|$))/;

function numberFromEnv(env, name, fallback) {
  const value = Number.parseFloat(env[name] ?? '');
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveMaintenanceConfig(env = process.env, root = repoRoot) {
  const cacheRoot = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches', 'Kordi')
    : path.join(homedir(), '.cache', 'kordi');
  return {
    repoRoot: path.resolve(root),
    targetDir: path.resolve(env.CARGO_TARGET_DIR || path.join(root, 'target')),
    stateFile: path.resolve(
      env.KORDI_DEBUG_ARTIFACT_STATE_FILE
        || path.join(cacheRoot, 'debug-artifact-maintenance.json'),
    ),
    maxTargetBytes: numberFromEnv(env, 'KORDI_DEBUG_ARTIFACT_MAX_GIB', 32) * GIB,
    minFreeBytes: numberFromEnv(env, 'KORDI_DEBUG_ARTIFACT_MIN_FREE_GIB', 100) * GIB,
    staleBuildAgeMs: numberFromEnv(env, 'KORDI_DEBUG_ARTIFACT_STALE_DAYS', 7) * DAY_MS,
    checkIntervalMs: numberFromEnv(env, 'KORDI_DEBUG_ARTIFACT_CHECK_HOURS', 24) * HOUR_MS,
  };
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function cargoCacheCandidates(targetDir) {
  const normalizedTarget = path.resolve(targetDir);
  if (normalizedTarget === path.parse(normalizedTarget).root || normalizedTarget === path.resolve(homedir())) {
    throw new Error(`Refusing unsafe Cargo target directory: ${normalizedTarget}`);
  }
  return SAFE_CARGO_CACHE_PARTS.map((parts) => ({
    path: path.join(normalizedTarget, ...parts),
    kind: 'cargo-debug-cache',
  }));
}

export function detectDebugBuildActivity(processText, ignoredPids = [process.pid, process.ppid]) {
  const ignored = new Set(ignoredPids.map(String));
  const lines = String(processText).split('\n').filter((line) => {
    const pid = line.trim().split(/\s+/, 1)[0];
    return pid && !ignored.has(pid);
  });
  return {
    rust: lines.some((line) => (
      /(?:^|[\s/])(cargo|rustc|rustdoc|clippy-driver)(?:\s|$)/.test(line)
      || /tauri(?:\.js)?\s+dev(?:\s|$)/.test(line)
      || /\/kordi-desktop(?:\s|$)/.test(line)
    )),
    xcode: lines.some((line) => /(?:\/Xcode\.app\/|(?:^|\s)xcodebuild(?:\s|$))/.test(line)),
  };
}

export function parseWorktreeRoots(porcelainText) {
  return String(porcelainText)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)))
    .sort();
}

export async function findStaleGeneratedBuildDirs(
  worktreeRoots,
  { nowMs = Date.now(), maxAgeMs = 7 * DAY_MS } = {},
) {
  const candidates = [];
  for (const worktreeRoot of worktreeRoots) {
    const buildRoot = path.join(worktreeRoot, '.build');
    let entries;
    try {
      entries = await readdir(buildRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_BUILD_DIR_PATTERN.test(entry.name)) continue;
      const candidatePath = path.join(buildRoot, entry.name);
      const metadata = await stat(candidatePath);
      if (nowMs - metadata.mtimeMs < maxAgeMs) continue;
      candidates.push({ path: candidatePath, kind: 'stale-generated-build' });
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export function buildMaintenancePlan({
  cargoCandidates,
  staleBuildCandidates,
  targetBytes,
  targetMeasurementTimedOut = false,
  freeBytes,
  maxTargetBytes,
  minFreeBytes,
  activity = { rust: false, xcode: false },
  force = false,
}) {
  const targetOverBudget = targetBytes > maxTargetBytes || targetMeasurementTimedOut;
  const diskUnderPressure = freeBytes < minFreeBytes;
  const candidates = [];
  const skipped = [];

  if (force || targetOverBudget || diskUnderPressure) {
    if (activity.rust) {
      skipped.push({ kind: 'cargo-debug-cache', reason: 'active Rust or desktop debug process' });
    } else {
      candidates.push(...cargoCandidates);
    }
  }

  if (force || staleBuildCandidates.length > 0) {
    if (activity.xcode) {
      skipped.push({ kind: 'stale-generated-build', reason: 'active Xcode process' });
    } else {
      candidates.push(...staleBuildCandidates);
    }
  }

  return {
    candidates,
    skipped,
    targetOverBudget,
    diskUnderPressure,
  };
}

export async function deleteArtifactCandidates(candidates, { delete: shouldDelete = false } = {}) {
  if (!shouldDelete) return [];
  const deleted = [];
  for (const candidate of candidates) {
    await rm(candidate.path, { recursive: true, force: true });
    deleted.push(candidate.path);
  }
  return deleted;
}

function runText(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) return '';
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function currentFreeBytes(targetPath) {
  const output = runText('df', ['-Pk', targetPath]);
  const line = output.trim().split('\n').at(-1) ?? '';
  const availableKiB = Number.parseInt(line.trim().split(/\s+/)[3] ?? '', 10);
  return Number.isFinite(availableKiB) ? availableKiB * 1024 : Number.POSITIVE_INFINITY;
}

function directorySize(targetPath, timeoutMs = 15_000) {
  const result = spawnSync('du', ['-sk', targetPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    return { bytes: Number.POSITIVE_INFINITY, timedOut: true };
  }
  if (result.error || result.status !== 0) return { bytes: 0, timedOut: false };
  const kib = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10);
  return { bytes: Number.isFinite(kib) ? kib * 1024 : 0, timedOut: false };
}

async function existingCandidates(candidates) {
  const existing = [];
  for (const candidate of candidates) {
    try {
      await stat(candidate.path);
      existing.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return existing;
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function formatGiB(bytes) {
  if (!Number.isFinite(bytes)) return 'measurement timed out';
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', phase: 'manual' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--auto') options.mode = 'auto';
    else if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--delete') options.mode = 'delete';
    else if (arg === '--phase') {
      options.phase = argv[index + 1] || '';
      index += 1;
      if (!['before', 'after', 'manual'].includes(options.phase)) {
        throw new Error('--phase must be before, after, or manual');
      }
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/debug-artifact-maintenance.mjs [options]\n\nOptions:\n  --dry-run              List all safe cleanup candidates (default)\n  --delete               Delete all listed safe cleanup candidates\n  --auto                 Enforce budgets for a debug launch\n  --phase before|after   Label automatic launch phase\n  -h, --help             Show this help\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  const config = resolveMaintenanceConfig();
  const nowMs = Date.now();
  const freeBytes = currentFreeBytes(config.repoRoot);
  const state = await readState(config.stateFile);
  const due = nowMs - Number(state.lastCheckedAtMs || 0) >= config.checkIntervalMs;
  const diskUnderPressure = freeBytes < config.minFreeBytes;
  if (options.mode === 'auto' && !due && !diskUnderPressure) {
    console.log(`[kordi-cleanup] ${options.phase} check skipped; the daily disk budget check is current.`);
    return;
  }

  const processText = runText('ps', ['-axo', 'pid=,args=']);
  const activity = detectDebugBuildActivity(processText);
  const worktreeText = runText('git', ['-C', config.repoRoot, 'worktree', 'list', '--porcelain']);
  const worktreeRoots = parseWorktreeRoots(worktreeText || `worktree ${config.repoRoot}\n`);
  const staleBuildCandidates = await findStaleGeneratedBuildDirs(worktreeRoots, {
    nowMs,
    maxAgeMs: options.mode === 'auto' ? config.staleBuildAgeMs : 0,
  });
  const targetMeasurement = directorySize(config.targetDir);
  const cargoCandidates = await existingCandidates(cargoCacheCandidates(config.targetDir));
  const plan = buildMaintenancePlan({
    cargoCandidates,
    staleBuildCandidates,
    targetBytes: targetMeasurement.bytes,
    targetMeasurementTimedOut: targetMeasurement.timedOut,
    freeBytes,
    maxTargetBytes: config.maxTargetBytes,
    minFreeBytes: config.minFreeBytes,
    activity,
    force: options.mode !== 'auto',
  });

  console.log(`[kordi-cleanup] Cargo target: ${formatGiB(targetMeasurement.bytes)} (budget ${formatGiB(config.maxTargetBytes)}).`);
  console.log(`[kordi-cleanup] Free disk: ${formatGiB(freeBytes)} (minimum ${formatGiB(config.minFreeBytes)}).`);
  for (const candidate of plan.candidates) {
    if (!isWithin(candidate.path, config.targetDir)
      && !worktreeRoots.some((root) => isWithin(candidate.path, path.join(root, '.build')))) {
      throw new Error(`Refusing cleanup candidate outside approved roots: ${candidate.path}`);
    }
    console.log(`[kordi-cleanup] ${options.mode === 'dry-run' ? 'Would remove' : 'Removing'} ${candidate.kind}: ${candidate.path}`);
  }
  for (const entry of plan.skipped) {
    console.log(`[kordi-cleanup] Kept ${entry.kind}: ${entry.reason}.`);
  }

  const shouldDelete = options.mode === 'delete' || options.mode === 'auto';
  const deleted = await deleteArtifactCandidates(plan.candidates, { delete: shouldDelete });
  if (options.mode === 'dry-run') {
    console.log('[kordi-cleanup] Dry run only; no files were deleted.');
  } else {
    console.log(`[kordi-cleanup] Removed ${deleted.length} generated artifact director${deleted.length === 1 ? 'y' : 'ies'}.`);
  }

  if (options.mode === 'auto') {
    await writeState(config.stateFile, {
      lastCheckedAtMs: plan.skipped.length === 0 ? nowMs : Number(state.lastCheckedAtMs || 0),
      lastPhase: options.phase,
      targetOverBudget: plan.targetOverBudget,
      diskUnderPressure: plan.diskUnderPressure,
      deletedCount: deleted.length,
      deferredCount: plan.skipped.length,
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[kordi-cleanup] ${error.message}`);
    process.exit(1);
  });
}
