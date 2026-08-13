import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMaintenancePlan,
  cargoCacheCandidates,
  deleteArtifactCandidates,
  detectDebugBuildActivity,
  findStaleGeneratedBuildDirs,
  parseWorktreeRoots,
} from './debug-artifact-maintenance.mjs';

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('cargo cleanup candidates contain only regenerable debug cache directories', () => {
  const candidates = cargoCacheCandidates('/tmp/kordi-cargo-target').map((entry) => entry.path);

  assert.deepEqual(candidates, [
    '/tmp/kordi-cargo-target/debug/deps',
    '/tmp/kordi-cargo-target/debug/incremental',
    '/tmp/kordi-cargo-target/debug/build',
    '/tmp/kordi-cargo-target/debug/.fingerprint',
  ]);
  assert.equal(candidates.some((candidate) => candidate.includes('/release')), false);
  assert.throws(() => cargoCacheCandidates('/'), /unsafe Cargo target directory/);
});

test('maintenance plan enforces disk budgets and keeps caches during active builds', () => {
  const cargoCandidates = cargoCacheCandidates('/tmp/kordi-cargo-target');
  const pressurePlan = buildMaintenancePlan({
    cargoCandidates,
    staleBuildCandidates: [],
    targetBytes: 40,
    freeBytes: 200,
    maxTargetBytes: 32,
    minFreeBytes: 100,
  });
  assert.deepEqual(pressurePlan.candidates, cargoCandidates);
  assert.equal(pressurePlan.targetOverBudget, true);

  const activePlan = buildMaintenancePlan({
    cargoCandidates,
    staleBuildCandidates: [],
    targetBytes: 40,
    freeBytes: 200,
    maxTargetBytes: 32,
    minFreeBytes: 100,
    activity: { rust: true, xcode: false },
  });
  assert.deepEqual(activePlan.candidates, []);
  assert.match(activePlan.skipped[0]?.reason ?? '', /active Rust/);
});

test('process activity distinguishes Kordi builds from unrelated target executables', () => {
  const active = detectDebugBuildActivity(`
101 /usr/bin/cargo test -p kordi-cli
102 /Applications/Xcode.app/Contents/MacOS/Xcode
103 /tmp/cargo-target/debug/supermonitor-server
`);
  assert.deepEqual(active, { rust: true, xcode: true });

  const unrelated = detectDebugBuildActivity('103 /tmp/cargo-target/debug/supermonitor-server\n');
  assert.deepEqual(unrelated, { rust: false, xcode: false });
});

test('stale build discovery selects generated directories but preserves archives and other files', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-debug-clean-'));
  try {
    const root = path.join(temp, 'worktree');
    const buildRoot = path.join(root, '.build');
    const staleIos = path.join(buildRoot, 'ios-simulator');
    const staleCargo = path.join(buildRoot, 'cargo-old-check');
    const archive = path.join(buildRoot, 'Kordi-release.xcarchive');
    const recentMac = path.join(buildRoot, 'macos-preview-target');
    await Promise.all([
      mkdir(staleIos, { recursive: true }),
      mkdir(staleCargo, { recursive: true }),
      mkdir(archive, { recursive: true }),
      mkdir(recentMac, { recursive: true }),
    ]);
    const oldDate = new Date('2026-01-01T00:00:00Z');
    await Promise.all([
      utimes(staleIos, oldDate, oldDate),
      utimes(staleCargo, oldDate, oldDate),
      utimes(archive, oldDate, oldDate),
    ]);

    const candidates = await findStaleGeneratedBuildDirs([root], {
      nowMs: Date.parse('2026-01-10T00:00:00Z'),
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert.deepEqual(candidates.map((entry) => entry.path), [staleCargo, staleIos].sort());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('artifact deletion is dry-run by default and removes only explicit candidates', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-debug-clean-'));
  try {
    const cache = path.join(temp, 'target', 'debug', 'incremental');
    const release = path.join(temp, 'target', 'release');
    await mkdir(cache, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(path.join(cache, 'artifact'), 'cache');
    await writeFile(path.join(release, 'artifact'), 'release');
    const candidates = [{ path: cache, kind: 'cargo-debug-cache' }];

    await deleteArtifactCandidates(candidates);
    assert.equal(await exists(cache), true);
    await deleteArtifactCandidates(candidates, { delete: true });
    assert.equal(await exists(cache), false);
    assert.equal(await exists(release), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('worktree parser reads only explicit worktree records', () => {
  assert.deepEqual(parseWorktreeRoots(`worktree /tmp/kordi\nHEAD abc\n\nworktree /tmp/kordi-wt\nHEAD def\n`), [
    '/tmp/kordi',
    '/tmp/kordi-wt',
  ]);
});

test('desktop debug entrypoints share one before-and-after maintenance lifecycle', async () => {
  const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const desktopPackage = JSON.parse(await readFile(new URL('../app/desktop/package.json', import.meta.url), 'utf8'));
  const wrapper = await readFile(new URL('./run-with-debug-artifact-maintenance.sh', import.meta.url), 'utf8');

  assert.equal(rootPackage.scripts['clean:debug-artifacts'], 'node scripts/debug-artifact-maintenance.mjs --dry-run');
  assert.equal(rootPackage.scripts['clean:debug-artifacts:delete'], 'node scripts/debug-artifact-maintenance.mjs --delete');
  for (const name of ['tauri:dev:profile', 'tauri:dev:multi:cloud', 'tauri:dev:cloud']) {
    assert.match(desktopPackage.scripts[name], /run-with-debug-artifact-maintenance\.sh/);
  }
  assert.match(wrapper, /--auto --phase "\$phase"/);
  assert.match(wrapper, /run_maintenance before/);
  assert.match(wrapper, /run_maintenance after/);
});

test('debug wrapper preserves command status and enforces a temporary target budget', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-debug-wrapper-'));
  try {
    const binDir = path.join(temp, 'bin');
    const targetDir = path.join(temp, 'target');
    const cacheDir = path.join(targetDir, 'debug', 'deps');
    const psPath = path.join(binDir, 'ps');
    await mkdir(binDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(psPath, '#!/bin/sh\nexit 0\n');
    await chmod(psPath, 0o700);
    await writeFile(path.join(cacheDir, 'artifact'), 'cache');

    const result = spawnSync(
      'bash',
      [new URL('./run-with-debug-artifact-maintenance.sh', import.meta.url).pathname, 'bash', '-c', 'exit 7'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          CARGO_TARGET_DIR: targetDir,
          KORDI_DEBUG_ARTIFACT_STATE_FILE: path.join(temp, 'state.json'),
          KORDI_DEBUG_ARTIFACT_MAX_GIB: '0',
          KORDI_DEBUG_ARTIFACT_MIN_FREE_GIB: '0',
          KORDI_DEBUG_ARTIFACT_STALE_DAYS: '10000',
          KORDI_DEBUG_ARTIFACT_CHECK_HOURS: '0',
        },
      },
    );

    assert.equal(result.status, 7, result.stderr);
    assert.equal(await exists(cacheDir), false);
    assert.match(result.stdout, /Removed 1 generated artifact directory/);
    const state = JSON.parse(await readFile(path.join(temp, 'state.json'), 'utf8'));
    assert.equal(state.lastPhase, 'after');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
