import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const releaseName = 'V0.0.1.beta3';
const appVersion = '0.0.1-beta.3';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('desktop release metadata is set for V0.0.1.beta3', () => {
  const pkg = readJson('../package.json');
  const packageLock = readJson('../package-lock.json');
  const tauri = readJson('../src-tauri/tauri.conf.json');
  const cloudTauri = readJson('../src-tauri/tauri.cloud.conf.json');
  const cargoToml = readText('../src-tauri/Cargo.toml');
  const cargoLock = readText('../src-tauri/Cargo.lock');
  const workspaceCargoLock = readText('../../../Cargo.lock');

  assert.equal(releaseName, 'V0.0.1.beta3');
  assert.equal(pkg.version, appVersion);
  assert.equal(packageLock.version, appVersion);
  assert.equal(packageLock.packages[''].version, appVersion);
  assert.equal(tauri.version, appVersion);
  assert.equal(tauri.productName, 'Kordi');
  assert.equal(cloudTauri.productName, 'Kordi');
  assert.match(cargoToml, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.3"/);
  assert.match(cargoLock, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.3"/);
  assert.match(workspaceCargoLock, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.3"/);
});
