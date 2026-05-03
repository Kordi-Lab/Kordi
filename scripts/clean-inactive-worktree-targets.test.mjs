import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCleanupPlan,
  deleteTargets,
  findTargetDirs,
} from './clean-inactive-worktree-targets.mjs';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function makeTarget(root, relativeTarget = 'target') {
  const target = path.join(root, relativeTarget);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'artifact.txt'), 'artifact');
  return target;
}

test('findTargetDirs returns top-level target directories and skips nested target contents', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-target-clean-'));
  try {
    const worktrees = path.join(temp, 'kordi-worktrees');
    const root = path.join(worktrees, 'inactive');
    const target = await makeTarget(root);
    await makeTarget(root, 'target/debug/nested/target');
    const bridgeTarget = await makeTarget(root, 'bridges/target');

    const targets = await findTargetDirs(worktrees);

    assert.deepEqual(targets.sort(), [bridgeTarget, target].sort());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('buildCleanupPlan keeps active roots and selects only inactive targets', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-target-clean-'));
  try {
    const worktrees = path.join(temp, 'kordi-worktrees');
    const activeRoot = path.join(worktrees, 'active-work');
    const inactiveRoot = path.join(worktrees, 'inactive-work');
    const activeTarget = await makeTarget(activeRoot);
    const inactiveTarget = await makeTarget(inactiveRoot);
    const inactiveBridgeTarget = await makeTarget(inactiveRoot, 'bridges/target');

    const plan = await buildCleanupPlan({
      worktreesDir: worktrees,
      activeRoots: [activeRoot],
      keepRoots: [],
    });

    assert.deepEqual(plan.deleteCandidates.map((entry) => entry.path).sort(), [
      inactiveBridgeTarget,
      inactiveTarget,
    ].sort());
    assert.equal(plan.kept.some((entry) => entry.path === activeTarget && entry.reason === 'active root'), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('deleteTargets is dry-run by default and deletes candidates only when requested', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'kordi-target-clean-'));
  try {
    const worktrees = path.join(temp, 'kordi-worktrees');
    const inactiveRoot = path.join(worktrees, 'inactive-work');
    const inactiveTarget = await makeTarget(inactiveRoot);
    const plan = await buildCleanupPlan({
      worktreesDir: worktrees,
      activeRoots: [],
      keepRoots: [],
    });

    await deleteTargets(plan.deleteCandidates, { delete: false });
    assert.equal(await exists(inactiveTarget), true);

    await deleteTargets(plan.deleteCandidates, { delete: true });
    assert.equal(await exists(inactiveTarget), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
