import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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

test('debug setup removes a temporary credential file when generation is interrupted', () => {
  const helper = read('scripts/dev-cloud-up.sh');
  const gitignore = read('.gitignore');
  const dockerignore = read('.dockerignore');

  assert.match(helper, /trap 'rm -f "\$temp_env"' EXIT/);
  assert.match(helper, /mv "\$temp_env" "\$env_file"\n\s*trap - EXIT/);
  assert.match(gitignore, /deploy\/dev\/\.env\.\?\?\?\?\?\?/);
  assert.match(dockerignore, /deploy\/dev\/\.env\.\?\?\?\?\?\?/);
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
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'docs/community-contributor-guide.md',
    'docs/run-cloud-desktop.md',
  ]) {
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

test('community guide routes contributors through issues and reviewed pull requests', () => {
  const guide = read('docs/community-contributor-guide.md');

  assert.match(guide, /github\.com\/Kordi-AI\/Kordi\/issues/);
  assert.match(guide, /Normal community contributions do not require production SSH/i);
  assert.match(guide, /Open a draft pull request early/i);
  assert.match(guide, /Do not include tokens, credentials, private infrastructure details/i);
  assert.match(guide, /pnpm check:ci/);
});

test('operator debug is allowlisted to the staged core GitHub account', () => {
  const allowlist = read('deploy/dev/operator-github-allowlist.txt')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);

  assert.deepEqual(allowlist, ['shuyhere']);
});

test('isolated desktop profiles initialize native Cloud account storage', () => {
  const profile = `storage-test-${process.pid}`;
  const port = '1499';
  const scriptPath = join(repoRoot, 'app', 'desktop', 'scripts', 'tauri-dev-profile.mjs');
  const generatedConfigPath = join(
    repoRoot,
    'app',
    'desktop',
    'src-tauri',
    '.tauri-dev',
    `${profile}-${port}.json`,
  );
  const env = {
    ...process.env,
    VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    VITE_KORDI_DEV_PROFILE: 'community',
  };

  try {
    const generated = spawnSync(
      process.execPath,
      [scriptPath, '--dry-run', '--profile', profile, '--port', port],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(
      generated.stdout,
      new RegExp(`"identifier": "io\\.kordi\\.cloud\\.${profile}"`),
    );

    const rejected = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--dry-run',
        '--profile',
        profile,
        '--port',
        port,
        '--identifier',
        `io.kordi.desktop.${profile}`,
      ],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must use io\.kordi\.cloud/i);
  } finally {
    rmSync(generatedConfigPath, { force: true });
  }
});

test('operator debug launcher rejects other GitHub accounts and exports no database credentials', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-operator-test-'));
  const binDir = join(tempRoot, 'bin');
  const capturePath = join(tempRoot, 'capture.txt');
  const scriptPath = join(repoRoot, 'scripts', 'dev-cloud-operator.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_GITHUB_LOGIN"\n');
    writeFileSync(
      join(binDir, 'pnpm'),
      '#!/bin/sh\nprintf \'%s\\n\' "$VITE_KORDI_CLOUD_API_BASE|$VITE_KORDI_DEV_PROFILE|$VITE_KORDI_PRODUCTION_DEBUG_ACK|${DATABASE_URL:-}|${REDIS_URL:-}|${S3_SECRET_KEY:-}|${KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY:-}|${KORDI_OAUTH_GOOGLE_CLIENT_SECRET:-}" > "$TEST_OPERATOR_CAPTURE"\n',
    );
    chmodSync(join(binDir, 'gh'), 0o755);
    chmodSync(join(binDir, 'pnpm'), 0o755);

    const baseEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      KORDI_OPERATOR_DEBUG_ACKNOWLEDGED: '1',
      TEST_OPERATOR_CAPTURE: capturePath,
      DATABASE_URL: 'postgresql://must-not-reach-desktop',
      REDIS_URL: 'redis://must-not-reach-desktop',
      S3_SECRET_KEY: 'must-not-reach-desktop',
      KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY: 'must-not-reach-desktop',
      KORDI_OAUTH_GOOGLE_CLIENT_SECRET: 'must-not-reach-desktop',
    };
    const rejected = spawnSync('bash', [scriptPath, 'https://kordi.ai'], {
      cwd: repoRoot,
      env: { ...baseEnv, TEST_GITHUB_LOGIN: 'not-allowlisted' },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /is not allowlisted/i);

    const allowed = spawnSync('bash', [scriptPath, 'https://kordi.ai'], {
      cwd: repoRoot,
      env: { ...baseEnv, TEST_GITHUB_LOGIN: 'shuyhere' },
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(
      readFileSync(capturePath, 'utf8').trim(),
      'https://kordi.ai|operator|1|||||',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
