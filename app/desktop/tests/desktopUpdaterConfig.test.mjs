import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('desktop package declares Tauri updater and process plugins', () => {
  const pkg = readJson(new URL('../package.json', import.meta.url));

  assert.match(pkg.dependencies['@tauri-apps/plugin-updater'], /^\^2\./);
  assert.match(pkg.dependencies['@tauri-apps/plugin-process'], /^\^2\./);
});

test('Tauri configs point updater checks at hosted Kordi, not GitHub or sslip', () => {
  const config = readJson(new URL('../src-tauri/tauri.conf.json', import.meta.url));
  const endpoints = config.plugins?.updater?.endpoints ?? [];

  assert.ok(endpoints.length > 0, 'expected updater endpoint');
  assert.ok(endpoints.every((endpoint) => endpoint.startsWith('https://coordinar.io/')), endpoints.join('\n'));
  assert.ok(endpoints.every((endpoint) => endpoint.includes('{{target}}')));
  assert.ok(endpoints.every((endpoint) => endpoint.includes('{{arch}}')));
  assert.ok(endpoints.every((endpoint) => !endpoint.includes('sslip.io')));
  assert.ok(endpoints.every((endpoint) => !endpoint.includes('github.com')));
});

test('Tauri bundler creates updater artifacts for release builds', () => {
  const config = readJson(new URL('../src-tauri/tauri.conf.json', import.meta.url));

  assert.equal(config.bundle.createUpdaterArtifacts, true);
});

test('desktop Rust app initializes updater and process plugins', () => {
  const libRs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.match(libRs, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(libRs, /tauri_plugin_process::init\(\)/);
});

test('desktop Rust manifest declares updater and process plugins', () => {
  const cargoToml = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');

  assert.match(cargoToml, /tauri-plugin-updater\s*=\s*\{\s*version\s*=\s*"2"/);
  assert.match(cargoToml, /tauri-plugin-process\s*=\s*\{\s*version\s*=\s*"2"/);
});
