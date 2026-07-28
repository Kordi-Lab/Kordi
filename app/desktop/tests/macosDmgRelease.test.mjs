import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultDmgBundleDir, validateDmgVolumeLayout } from '../scripts/assert-macos-dmg-release.mjs';

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
    /tauri build --config src-tauri\/tauri\.cloud\.conf\.json --bundles (?:app,)?dmg/,
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
