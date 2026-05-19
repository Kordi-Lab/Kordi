import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateDmgVolumeLayout } from '../scripts/assert-macos-dmg-release.mjs';

function readPackageJson() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}

function makeVolume() {
  return mkdtempSync(join(tmpdir(), 'kordi-dmg-volume-'));
}

test('package exposes an explicit Cloud DMG release command', () => {
  const pkg = readPackageJson();

  assert.match(pkg.scripts['tauri:build:cloud:dmg'], /tauri build --config src-tauri\/tauri\.cloud\.conf\.json --bundles dmg/);
  assert.match(pkg.scripts['tauri:build:cloud:dmg'], /release:verify-cloud-dmg/);
  assert.match(pkg.scripts['release:verify-cloud-dmg'], /assert-macos-dmg-release\.mjs --app-name 'Kordi Cloud'/);
});

test('validateDmgVolumeLayout accepts an app bundle with Applications drag target', () => {
  const volume = makeVolume();
  mkdirSync(join(volume, 'Kordi Cloud.app'));
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.doesNotThrow(() => validateDmgVolumeLayout(volume, { appName: 'Kordi Cloud' }));
});

test('validateDmgVolumeLayout rejects a DMG volume without the app bundle', () => {
  const volume = makeVolume();
  symlinkSync('/Applications', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi Cloud' }),
    /Missing Kordi Cloud\.app/,
  );
});

test('validateDmgVolumeLayout rejects a DMG volume without an Applications symlink', () => {
  const volume = makeVolume();
  mkdirSync(join(volume, 'Kordi Cloud.app'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi Cloud' }),
    /Missing Applications symlink/,
  );
});

test('validateDmgVolumeLayout rejects an Applications symlink pointing elsewhere', () => {
  const volume = makeVolume();
  mkdirSync(join(volume, 'Kordi Cloud.app'));
  symlinkSync('/tmp', join(volume, 'Applications'));

  assert.throws(
    () => validateDmgVolumeLayout(volume, { appName: 'Kordi Cloud' }),
    /Applications symlink must point to \/Applications/,
  );
});
