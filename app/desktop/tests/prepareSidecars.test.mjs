import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
  assert.deepEqual(tauriConfig.bundle.externalBin, ['binaries/kordi']);
  assert.equal(cloudTauriConfig.bundle, undefined);
});
