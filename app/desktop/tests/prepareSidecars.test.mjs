import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ompExternalBins } from '../scripts/omp-sidecar-config.mjs';

const source = readFileSync(new URL('../scripts/prepare-sidecars.mjs', import.meta.url), 'utf8');
const workspaceConfig = JSON.parse(
  readFileSync(new URL('../kordi.workspace.json', import.meta.url), 'utf8'),
);
const tauriConfig = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);
const cloudTauriConfig = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.cloud.conf.json', import.meta.url), 'utf8'),
);

test('prepare sidecars resolves Cargo binaries from shared CARGO_TARGET_DIR when set', () => {
  assert.match(source, /process\.env\.CARGO_TARGET_DIR/);
  assert.match(source, /resolve\(process\.env\.CARGO_TARGET_DIR, 'release'/);
});

test('Cloud desktop does not build, copy, sign, or package the Bridges CLI', () => {
  assert.doesNotMatch(source, /Bridges|bridgesManifestPath|bridgesBinary|bridges-\$\{/);
  assert.equal(workspaceConfig.bridgesPath, undefined);
  assert.equal(workspaceConfig.bridgesManifestPath, undefined);
  assert.equal(workspaceConfig.bridgesBinary, undefined);
  assert.deepEqual(tauriConfig.bundle.externalBin, [
    'binaries/kordi',
  ]);
  assert.equal(cloudTauriConfig.bundle, undefined);
});

test('OMP standalone build and its version-matched native addon ship together', () => {
  assert.match(source, /build-standalone\.mjs/);
  assert.match(source, /binariesDir, targetTriple/);
});

test('OMP sidecars use the native addon for the exact target platform', () => {
  assert.deepEqual(ompExternalBins('aarch64-apple-darwin', 'darwin', 'arm64'), [
    'binaries/kordi', 'binaries/kordi-omp', 'binaries/pi_natives.darwin-arm64.node',
  ]);
  assert.deepEqual(ompExternalBins('x86_64-unknown-linux-gnu', 'linux', 'x64'), [
    'binaries/kordi', 'binaries/kordi-omp', 'binaries/pi_natives.linux-x64.node',
  ]);
  assert.deepEqual(ompExternalBins('x86_64-pc-windows-msvc', 'win32', 'x64'), ['binaries/kordi']);
  assert.throws(() => ompExternalBins('x86_64-apple-darwin', 'darwin', 'arm64'));
});
