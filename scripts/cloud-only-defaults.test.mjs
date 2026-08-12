import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('root commands expose only Cloud product entrypoints', () => {
  const scripts = readJson('package.json').scripts;
  const scriptNames = Object.keys(scripts);
  const scriptBody = Object.entries(scripts).map(([name, command]) => `${name}: ${command}`).join('\n');

  assert.equal(scripts.dev, 'pnpm dev:cloud');
  assert.equal(scripts['dev:desktop'], 'pnpm dev:cloud');
  assert.equal(scripts['build:desktop'], 'pnpm build:cloud');
  assert.equal(scripts['dev:cloud'], 'pnpm --dir app/desktop tauri:dev:cloud');
  assert.equal(scripts['build:cloud'], 'pnpm --dir app/desktop tauri:build:cloud');
  assert.equal(scripts['debug:cloud:up'], 'bash scripts/dev-cloud-up.sh');
  assert.equal(scripts['debug:cloud:smoke'], 'bash scripts/dev-cloud-smoke.sh');
  assert.equal(scripts['debug:cloud:reset'], 'bash scripts/dev-cloud-reset.sh');
  assert.deepEqual(scriptNames.filter((name) => name.includes(':local')), []);
  assert.doesNotMatch(scriptBody, /\bVITE_KORDI_EDITION\b|\bKORDI_EDITION\b/);
  assert.doesNotMatch(scriptBody, /kordi-app-server/);
  assert.equal(scripts['run:app-server'], undefined);
  assert.equal(scripts['check:app-server'], undefined);
});

test('desktop package commands expose only Cloud product entrypoints', () => {
  const scripts = readJson('app/desktop/package.json').scripts;
  const scriptNames = Object.keys(scripts);
  const scriptBody = Object.entries(scripts).map(([name, command]) => `${name}: ${command}`).join('\n');

  assert.equal(scripts['tauri:dev'], 'pnpm tauri:dev:cloud');
  assert.equal(scripts['tauri:build'], 'pnpm tauri:build:cloud');
  assert.match(scripts['tauri:dev:cloud'], /tauri dev --config src-tauri\/tauri\.cloud\.conf\.json/);
  assert.match(scripts['tauri:build:cloud'], /tauri build --config src-tauri\/tauri\.cloud\.conf\.json/);
  assert.match(
    scripts['tauri:build:cloud:dmg'],
    /tauri build --config src-tauri\/tauri\.cloud\.conf\.json --bundles app,dmg/,
    'release builds must include the app bundle so Tauri emits the signed updater archive',
  );
  assert.deepEqual(scriptNames.filter((name) => name.includes(':local')), []);
  assert.doesNotMatch(scriptBody, /\bVITE_KORDI_EDITION\b|\bKORDI_EDITION\b/);
});

test('desktop unit command discovers both TypeScript test suffixes without racing timing budgets', () => {
  const command = readJson('app/desktop/package.json').scripts['test:unit'];

  assert.match(command, /tests\/\*\.test\.tsx/);
  assert.match(command, /tests\/\*\.test\.ts(?:\s|$)/);
  assert.match(command, /--test-concurrency=1 tests\/\*\.test\.ts/);
});

test('public docs use neutral product wording and safe host guidance', () => {
  const publicDocs = [
    'AGENTS.md',
    'README.md',
    'CONTRIBUTING.md',
    'app/desktop/README.md',
    'docs/development-environments.md',
    'docs/development.md',
    'docs/community-contributor-guide.md',
    'docs/run-cloud-desktop.md',
    'docs/self-hosted-debug.md',
    'docs/cloud-edition.md',
    'docs/hosted-cloud-developer-guide.md',
  ].map((path) => `${path}\n${readText(path)}`).join('\n\n');

  assert.match(publicDocs, /https:\/\/coordinar\.io/);
  assert.match(publicDocs, /<PUBLIC_TEST_CLOUD_API_BASE>/);
  assert.match(publicDocs, /Hosted\/dev runs must set `VITE_KORDI_CLOUD_API_BASE`/);
  assert.match(publicDocs, /Development launches fail closed/);
  assert.doesNotMatch(publicDocs, /https:\/\/kordi\.cloud/);
  assert.doesNotMatch(publicDocs, /sslip\.io|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+/i);
  assert.doesNotMatch(publicDocs, /gcloud compute ssh (?!"<DEV_GCE_INSTANCE>")/i);
  assert.doesNotMatch(publicDocs, /--project\s+(?!"<DEV_GCP_PROJECT>")["']?[a-z][a-z0-9-]{4,}/i);
  assert.doesNotMatch(publicDocs, /(?:^|[^\d.])(?!(?:127|0|10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.)\d{1,3}(?:\.\d{1,3}){3}(?:$|[^\d.])/);
  assert.doesNotMatch(publicDocs, /local app stack/i);
  assert.doesNotMatch(publicDocs, /app-facing local orchestration/i);
  assert.doesNotMatch(publicDocs, /KORDI_EDITION|VITE_KORDI_EDITION|dev:local|tauri:dev:local|build:local|tauri:build:local/);
  assert.doesNotMatch(publicDocs, /Cloud-first|Cloud-only|Cloud Edition|Cloud Desktop|Cloud desktop|Cloud product|Cloud build|Cloud package|only product mode/i);
});

test('development docs enforce the product-server impact preflight', () => {
  const policy = readText('docs/hosted-cloud-developer-guide.md');
  const entrypoints = [
    'AGENTS.md',
    'README.md',
    'CONTRIBUTING.md',
    'app/desktop/README.md',
    'app/ios/README.md',
    'docs/development.md',
    'docs/run-cloud-desktop.md',
    'docs/cloud-edition.md',
    'docs/app-server.md',
    'docs/architecture.md',
    'docs/self-hosted-debug.md',
    'docs/community-contributor-guide.md',
    'docs/ios-development.md',
    'docs/cloud-mobile.md',
  ];

  assert.match(policy, /anything that requires a product-server restart/);
  assert.match(policy, /corresponding product-server machine through `https:\/\/coordinar\.io`/);
  assert.match(policy, /first end-to-end validation through `https:\/\/coordinar\.io`/);
  assert.match(policy, /Never route this path through `https:\/\/kordi\.ai`/);
  assert.match(policy, /pnpm dev:cloud:operator -- "https:\/\/kordi\.ai"/);
  assert.match(policy, /scripts\/dev-cloud-operator\.sh https:\/\/kordi\.ai/);
  assert.match(policy, /stop and fail closed/i);
  assert.match(policy, /Never silently fall back .*community\/debug-server profile/);

  for (const path of entrypoints) {
    const contents = readText(path);
    assert.match(
      contents,
      /hosted-cloud-developer-guide\.md#required-preflight-before-preview-or-debug/,
      `${path} must link to the canonical environment preflight`,
    );
    assert.match(
      contents,
      /development-environments\.md/,
      `${path} must link to the canonical environment isolation guide`,
    );
  }
});

test('development environment guide documents isolated remote access without private targets', () => {
  const guide = readText('docs/development-environments.md');
  const repositoryAgents = readText('AGENTS.md');
  const packageScripts = readJson('package.json').scripts;
  const englishCheck = readText('scripts/check-english-only-diff.sh');
  const preCommit = readText('.githooks/pre-commit');

  assert.match(guide, /gcloud compute ssh "<DEV_GCE_INSTANCE>"/);
  assert.match(guide, /--project "<DEV_GCP_PROJECT>"/);
  assert.match(guide, /--zone "<DEV_GCP_ZONE>"/);
  assert.match(guide, /--tunnel-through-iap/);
  assert.match(guide, /127\.0\.0\.1:17081:127\.0\.0\.1:17081/);
  assert.match(guide, /VITE_KORDI_DEV_PROFILE=community/);
  assert.match(guide, /io\.kordi\.cloud\.\*/);
  assert.match(guide, /oauth\/github\/callback/);
  assert.match(guide, /oauth\/google\/callback/);
  assert.match(repositoryAgents, /pnpm check:english/);
  assert.equal(packageScripts['check:english'], 'bash scripts/check-english-only-diff.sh');
  assert.match(englishCheck, /\[\\p\{Han\}\]/);
  assert.match(englishCheck, /git diff --no-index --numstat -- \/dev\/null/);
  assert.match(englishCheck, /\^-\[\[:space:\]\]\+\-\[\[:space:\]\]\+/);
  assert.match(preCommit, /pnpm check:english/);
});

test('operator documentation uses private product placeholders', () => {
  const operatorDocs = [
    'docs/release.md',
    'docs/self-hosted-ci.md',
    'bridges/cloud-server/deploy/README.md',
    'bridges/cloud-server/deploy/k3s/README.md',
  ].map((path) => `${path}\n${readText(path)}`).join('\n\n');

  assert.match(operatorDocs, /<PRODUCT_GCP_PROJECT>/);
  assert.match(operatorDocs, /<PRODUCT_GCP_ZONE>/);
  assert.match(operatorDocs, /<PRODUCT_GCE_INSTANCE>/);
  assert.match(operatorDocs, /development-environments\.md/);
  assert.doesNotMatch(operatorDocs, /KORDI_CLOUD_SSH_TARGET=["']?[a-z0-9]/i);
  assert.doesNotMatch(operatorDocs, /KORDI_CLOUD_SSH_ZONE=["']?[a-z0-9]/i);
  assert.doesNotMatch(operatorDocs, /KORDI_CLOUD_GCP_PROJECT=["']?[a-z0-9]/i);
});
