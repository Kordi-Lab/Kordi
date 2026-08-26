import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, desktopRoot), 'utf8'));
}

function readText(relativePath) {
  return readFileSync(new URL(relativePath, desktopRoot), 'utf8');
}

const acceptanceEndpoint =
  'https://kordi.ai/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';

test('desktop Tauri config creates signed updater artifacts from the product endpoint', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  const cloud = readJson('src-tauri/tauri.cloud.conf.json');
  const endpoints = base.plugins?.updater?.endpoints;
  const pubkey = base.plugins?.updater?.pubkey;

  assert.equal(base.bundle?.createUpdaterArtifacts, true);
  assert.deepEqual(endpoints, [
    'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
  ]);
  assert.equal(typeof pubkey, 'string');
  assert.match(pubkey, /^[A-Za-z0-9+/=]{100,}$/);
  assert.doesNotMatch(pubkey, /replace|template|example|todo/i);
  assert.equal(cloud.identifier, 'io.kordi.cloud');

  const serializedEndpoints = JSON.stringify(endpoints);
  assert.doesNotMatch(serializedEndpoints, /http:|github|minio|localhost|127\.0\.0\.1|googleapis|gcp/i);
});

test('acceptance flavors are ad-hoc, updater-signed, and isolated from beta', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  const cloud = readJson('src-tauri/tauri.cloud.conf.json');
  const target = readJson('src-tauri/tauri.cloud.acceptance.conf.json');
  const bootstrap = readJson('src-tauri/tauri.cloud.acceptance-bootstrap.conf.json');
  const pkg = readJson('package.json');

  assert.equal(base.version, '0.0.1-beta.16');
  assert.equal(base.bundle?.macOS?.signingIdentity, undefined);
  assert.deepEqual(base.plugins?.updater?.endpoints, [
    'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
  ]);
  assert.equal(cloud.identifier, 'io.kordi.cloud');

  for (const flavor of [target, bootstrap]) {
    assert.equal(flavor.productName, 'Kordi');
    assert.equal(flavor.identifier, 'io.kordi.cloud');
    assert.equal(flavor.bundle?.macOS?.signingIdentity, '-');
    assert.deepEqual(flavor.plugins?.updater?.endpoints, [acceptanceEndpoint]);
    assert.equal(flavor.plugins?.updater?.pubkey, undefined);
  }
  assert.equal(target.version, undefined);
  assert.equal(bootstrap.version, '0.0.1-beta.5.1');
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-preview'], /tauri\.cloud\.acceptance\.conf\.json/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-bootstrap'], /tauri\.cloud\.acceptance-bootstrap\.conf\.json/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-preview'], /--bundles app,dmg/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-bootstrap'], /--bundles app,dmg/);
});

test('desktop capability grants updater permission without generic process-plugin access', () => {
  const capability = readJson('src-tauri/capabilities/default.json');

  assert.ok(capability.permissions.includes('updater:default'));
  assert.ok(!capability.permissions.some((permission) => permission.startsWith('process:')));
});

test('desktop manifests use Tauri updater without the generic process relaunch plugin', () => {
  const pkg = readJson('package.json');
  const cargo = readText('src-tauri/Cargo.toml');
  const lib = readText('src-tauri/src/lib.rs');

  assert.match(pkg.dependencies['@tauri-apps/plugin-updater'], /^\^?2\./);
  assert.equal(pkg.dependencies['@tauri-apps/plugin-process'], undefined);
  assert.match(cargo, /^tauri-plugin-updater\s*=\s*"2"/m);
  assert.doesNotMatch(cargo, /^tauri-plugin-process\s*=/m);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.doesNotMatch(lib, /tauri_plugin_process/);
});
