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

test('desktop Tauri config creates signed updater artifacts from the product endpoint', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  const cloud = readJson('src-tauri/tauri.cloud.conf.json');
  const endpoints = base.plugins?.updater?.endpoints;
  const pubkey = base.plugins?.updater?.pubkey;

  assert.equal(base.bundle?.createUpdaterArtifacts, true);
  assert.deepEqual(endpoints, [
    'https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
  ]);
  assert.equal(typeof pubkey, 'string');
  assert.match(pubkey, /^[A-Za-z0-9+/=]{100,}$/);
  assert.doesNotMatch(pubkey, /replace|template|example|todo/i);
  assert.equal(cloud.identifier, 'io.kordi.cloud');

  const serializedEndpoints = JSON.stringify(endpoints);
  assert.doesNotMatch(serializedEndpoints, /http:|github|minio|localhost|127\.0\.0\.1|googleapis|gcp/i);
});

test('desktop capability grants only the updater and relaunch plugin permissions needed by the UI', () => {
  const capability = readJson('src-tauri/capabilities/default.json');

  assert.ok(capability.permissions.includes('updater:default'));
  assert.ok(capability.permissions.includes('process:allow-restart'));
});

test('desktop JavaScript and Rust manifests use Tauri v2 updater and process plugins', () => {
  const pkg = readJson('package.json');
  const cargo = readText('src-tauri/Cargo.toml');
  const lib = readText('src-tauri/src/lib.rs');

  assert.match(pkg.dependencies['@tauri-apps/plugin-updater'], /^\^?2\./);
  assert.match(pkg.dependencies['@tauri-apps/plugin-process'], /^\^?2\./);
  assert.match(cargo, /^tauri-plugin-updater\s*=\s*"2"/m);
  assert.match(cargo, /^tauri-plugin-process\s*=\s*"2"/m);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
});
