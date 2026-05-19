import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { resolveBuiltBinaryPath } from '../scripts/prepare-sidecars.mjs';

test('resolveBuiltBinaryPath respects CARGO_TARGET_DIR for release binaries', () => {
  const repoPath = '/repo/agent';
  const sharedTarget = '/tmp/shared-cargo-target';

  assert.equal(
    resolveBuiltBinaryPath({
      repoPath,
      configuredBinaryPath: '../target/release/kordi',
      cargoTargetDir: sharedTarget,
    }),
    join(sharedTarget, 'release', 'kordi'),
  );
});

test('resolveBuiltBinaryPath keeps configured repo-relative path without CARGO_TARGET_DIR', () => {
  assert.equal(
    resolveBuiltBinaryPath({
      repoPath: '/repo/agent',
      configuredBinaryPath: '../target/release/kordi',
      cargoTargetDir: '',
    }),
    '/repo/target/release/kordi',
  );
});
