import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('self-hosted debug stack is loopback-only and production-independent', () => {
  const compose = read('deploy/dev/compose.yaml');

  for (const service of ['postgres', 'redis', 'nats', 'minio', 'minio-init', 'cloud-server']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(compose, /127\.0\.0\.1:\$\{KORDI_DEBUG_API_PORT:-17081\}:17081/);
  assert.match(compose, /127\.0\.0\.1:\$\{KORDI_DEBUG_MINIO_PORT:-19000\}:9000/);
  assert.doesNotMatch(compose, /coordinar\.io|hai-gcp-representation|kordi-product/i);
  assert.doesNotMatch(compose, /^\s*-\s*"?(?:5432|6379|4222):/m);
});

test('debug environment template contains placeholders instead of usable credentials', () => {
  const template = read('deploy/dev/.env.example');

  assert.match(template, /POSTGRES_PASSWORD=<generated-by-debug-helper>/);
  assert.match(template, /MINIO_ROOT_PASSWORD=<generated-by-debug-helper>/);
  assert.match(template, /KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY=<generated-by-debug-helper>/);
  assert.doesNotMatch(template, /coordinar\.io|hai-gcp-representation|kordi-product/i);
});

test('self-hosted guide uses the safe helper and explicit loopback API origin', () => {
  const guide = read('docs/self-hosted-debug.md');

  assert.match(guide, /pnpm debug:cloud:up/);
  assert.match(guide, /VITE_KORDI_CLOUD_API_BASE=http:\/\/127\.0\.0\.1:17081/);
  assert.match(guide, /never copies production data/i);
  assert.match(guide, /production access is controlled by server-side IAM/i);
  assert.match(guide, /pnpm debug:cloud:smoke/);
  assert.match(guide, /pnpm dev:cloud:multi -- --reset --users user1,user2/);
  assert.match(guide, /pnpm debug:cloud:reset -- --yes/);
  assert.match(guide, /pnpm check:ci/);
  assert.doesNotMatch(guide, /127\.0\.0\.1:7890/);
});

test('public contributor entrypoints lead to the isolated development workflow', () => {
  for (const path of ['README.md', 'CONTRIBUTING.md', 'docs/run-cloud-desktop.md']) {
    const document = read(path);
    assert.match(document, /pnpm debug:cloud:up/, `${path} should start the isolated backend`);
    assert.match(
      document,
      /VITE_KORDI_CLOUD_API_BASE=http:\/\/127\.0\.0\.1:17081/,
      `${path} should use the loopback API`,
    );
    assert.match(document, /self-hosted-debug\.md/, `${path} should link the full local guide`);
  }

  assert.doesNotMatch(
    read('README.md'),
    /uses the production hosted API at `https:\/\/coordinar\.io` by default/i,
  );
});
