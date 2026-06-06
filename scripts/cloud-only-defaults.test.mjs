import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('root commands default to Cloud product entrypoints', () => {
  const scripts = readJson('package.json').scripts;

  assert.equal(scripts.dev, 'pnpm dev:cloud');
  assert.equal(scripts['dev:desktop'], 'pnpm dev:cloud');
  assert.equal(scripts['build:desktop'], 'pnpm build:cloud');
  assert.match(scripts['dev:cloud'], /VITE_KORDI_EDITION=cloud/);
  assert.match(scripts['dev:cloud'], /KORDI_EDITION=cloud/);
  assert.match(scripts['dev:cloud'], /tauri:dev:cloud/);
  assert.match(scripts['dev:local'], /kordi-app-server/);
  assert.equal(scripts['run:app-server'], undefined);
  assert.equal(scripts['check:app-server'], undefined);
});

test('desktop package commands default to Cloud product entrypoints', () => {
  const scripts = readJson('app/desktop/package.json').scripts;

  assert.equal(scripts['tauri:dev'], 'pnpm tauri:dev:cloud');
  assert.equal(scripts['tauri:build'], 'pnpm tauri:build:cloud');
  assert.match(scripts['tauri:dev:cloud'], /VITE_KORDI_EDITION=cloud/);
  assert.match(scripts['tauri:dev:cloud'], /KORDI_EDITION=cloud/);
  assert.match(scripts['tauri:dev:cloud'], /tauri dev --config src-tauri\/tauri\.cloud\.conf\.json/);
  assert.match(scripts['tauri:dev:local'], /tauri:prepare-sidecars/);
});

test('public docs use product host for production and placeholder for test Cloud servers', () => {
  const publicDocs = [
    'README.md',
    'app/desktop/README.md',
    'docs/development.md',
    'docs/run-cloud-desktop.md',
    'docs/cloud-edition.md',
    'docs/hosted-cloud-developer-guide.md',
  ].map((path) => `${path}\n${readText(path)}`).join('\n\n');

  assert.match(publicDocs, /https:\/\/coordinar\.io/);
  assert.match(publicDocs, /<PUBLIC_TEST_CLOUD_API_BASE>/);
  assert.doesNotMatch(publicDocs, /https:\/\/kordi\.cloud/);
  assert.doesNotMatch(publicDocs, /korde-product-cloud\.[^\s`]+/);
  assert.doesNotMatch(publicDocs, /local app stack/i);
  assert.doesNotMatch(publicDocs, /app-facing local orchestration/i);
});
