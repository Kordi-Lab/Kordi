import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertOmpSidecarStarts,
  defaultDmgBundleDir,
  validateDmgVolumeLayout,
} from '../scripts/assert-macos-dmg-release.mjs';

function readPackageJson() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}

function makeVolume() {
  return mkdtempSync(join(tmpdir(), 'kordi-dmg-volume-'));
}

function addCloudAppExecutables(volume) {
  const executableDir = join(volume, 'Kordi.app', 'Contents', 'MacOS');
  mkdirSync(executableDir, { recursive: true });
  writeFileSync(join(executableDir, 'kordi-desktop'), '', { mode: 0o755 });
  writeFileSync(join(executableDir, 'kordi'), '', { mode: 0o755 });
  writeFileSync(join(executableDir, 'kordi-omp'), '', { mode: 0o755 });
  writeFileSync(join(executableDir, `pi_natives.darwin-${process.arch}.node`), '');
}

function writeOmpSidecar(volume, script) {
  const path = join(volume, 'Kordi.app', 'Contents', 'MacOS', 'kordi-omp');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return join(volume, 'Kordi.app');
}

test('defaultDmgBundleDir respects CARGO_TARGET_DIR used by Tauri builds when it has bundles', () => {
  const targetRoot = mkdtempSync(join(tmpdir(), 'kordi-cargo-target-'));
  const bundleDir = join(targetRoot, 'release', 'bundle', 'dmg');
  mkdirSync(bundleDir, { recursive: true });

  assert.equal(defaultDmgBundleDir({ cargoTargetDir: targetRoot }), bundleDir);
});

test('defaultDmgBundleDir falls back to the workspace target bundle directory', () => {
  assert.match(
    defaultDmgBundleDir({ cargoTargetDir: '' }),
    /\/target\/release\/bundle\/dmg$/,
  );
});

test('package exposes an explicit Cloud DMG release command for a Kordi-named app', () => {
  const pkg = readPackageJson();

  assert.match(
    pkg.scripts['tauri:build:cloud:dmg'],
    /build-macos-desktop\.sh --config src-tauri\/tauri\.cloud\.conf\.json --bundles (?:app,)?dmg/,
  );
  assert.match(pkg.scripts['tauri:build:cloud:dmg'], /release:verify-cloud-dmg/);
  assert.match(pkg.scripts['release:verify-cloud-dmg'], /assert-macos-dmg-release\.mjs --app-name Kordi/);
  assert.doesNotMatch(pkg.scripts['release:verify-cloud-dmg'], /Kordi Cloud/);
});

test('validateDmgVolumeLayout accepts an app bundle with Applications drag target', () => {
  const volume = makeVolume();
  addCloudAppExecutables(volume);
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.doesNotThrow(() => validateDmgVolumeLayout(volume, { appName: 'Kordi' }));
});

test('validateDmgVolumeLayout rejects a legacy Bridges executable in the Cloud app', () => {
  const volume = makeVolume();
  addCloudAppExecutables(volume);
  writeFileSync(join(volume, 'Kordi.app', 'Contents', 'MacOS', 'bridges'), '', { mode: 0o755 });
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi' }),
    /unexpected executables: bridges/,
  );
});

test('validateDmgVolumeLayout rejects a Cloud app without the agent sidecar addon', () => {
  const volume = makeVolume();
  const executableDir = join(volume, 'Kordi.app', 'Contents', 'MacOS');
  mkdirSync(executableDir, { recursive: true });
  for (const name of ['kordi-desktop', 'kordi', 'kordi-omp']) {
    writeFileSync(join(executableDir, name), '', { mode: 0o755 });
  }
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi' }),
    /missing expected executables: pi_natives\.darwin-/,
  );
});

test('assertOmpSidecarStarts accepts a sidecar that reports ready', () => {
  const volume = makeVolume();
  addCloudAppExecutables(volume);
  const app = writeOmpSidecar(volume, `echo '{"schemaVersion":1,"type":"ready"}'`);

  assert.doesNotThrow(() => assertOmpSidecarStarts(app));
});

test('assertOmpSidecarStarts rejects a sidecar that fails before ready', () => {
  const volume = makeVolume();
  addCloudAppExecutables(volume);
  const app = writeOmpSidecar(volume, 'echo "SharedArrayBuffer is not defined" >&2; exit 1');

  assert.throws(() => assertOmpSidecarStarts(app), /did not report ready: SharedArrayBuffer is not defined/);
});

test('validateDmgVolumeLayout rejects a DMG volume without the app bundle', () => {
  const volume = makeVolume();
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi' }),
    /Missing Kordi\.app/,
  );
});

test('validateDmgVolumeLayout rejects a DMG volume without an Applications symlink', () => {
  const volume = makeVolume();
  mkdirSync(join(volume, 'Kordi.app'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi' }),
    /Missing Applications symlink/,
  );
});

test('validateDmgVolumeLayout rejects an Applications symlink pointing elsewhere', () => {
  const volume = makeVolume();
  mkdirSync(join(volume, 'Kordi.app'));
  symlinkSync('/tmp', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi' }),
    /Applications symlink must point to \/Applications/,
  );
});
