import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { read, repoRoot, writeExecutable } from './local-debug-stack-helpers.mjs';

// The OMP route worker has its own bearer so a compromised worker dependency never
// holds the runner token. Every value below is synthetic.

test('the OMP route worker token is a dedicated placeholder, never the runner token', () => {
  const template = read('deploy/dev/.env.example');
  const compose = read('deploy/dev/compose.yaml');

  assert.match(template, /KORDI_OMP_ROUTE_WORKER_TOKEN=<generated-by-debug-helper>/);
  assert.equal(
    compose.match(/KORDI_OMP_ROUTE_WORKER_TOKEN: \$\{KORDI_OMP_ROUTE_WORKER_TOKEN:\?/g)?.length,
    2,
    'cloud-server and omp-route-worker both read the dedicated variable',
  );
  assert.doesNotMatch(compose, /KORDI_OMP_ROUTE_WORKER_TOKEN: \$\{KORDI_CLOUD_RUNNER_TOKEN/);
});

test('debug setup generates the OMP route worker token for a new env file', () => {
  const helper = read('scripts/dev-cloud-up.sh');
  const generation = helper.slice(helper.indexOf('if [[ ! -f "$env_file" ]]'), helper.indexOf('mv "$temp_env"'));

  assert.match(generation, /printf 'KORDI_OMP_ROUTE_WORKER_TOKEN=%s\\n' "\$\(openssl rand -hex 32\)"/);
});

test('debug setup adds the token to an older env file and keeps shell values out of compose', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-debug-secrets-test-'));
  const binDir = join(tempRoot, 'bin');
  const envPath = join(tempRoot, 'dev.env');
  const capturePath = join(tempRoot, 'compose-env.txt');
  try {
    mkdirSync(binDir);
    writeExecutable(join(binDir, 'openssl'), '#!/bin/sh\nprintf \'synthetic-generated-secret\\n\'\n');
    writeExecutable(join(binDir, 'curl'), '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n');
    writeExecutable(
      join(binDir, 'docker'),
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  info) exit 0 ;;',
        '  inspect) if [[ "$*" == *Health* ]]; then printf \'healthy\\n\'; else printf \'true\\n\'; fi ;;',
        '  compose)',
        '    if [[ " $* " == *" up "* ]]; then',
        '      printf \'%s\\n\' "${KORDI_OMP_ROUTE_WORKER_TOKEN:-}|${KORDI_CLOUD_RUNNER_TOKEN:-}" > "$TEST_COMPOSE_CAPTURE"',
        '    fi',
        '    if [[ " $* " == *" ps -q "* ]]; then printf \'synthetic-container\\n\'; fi',
        '    ;;',
        'esac',
        '',
      ].join('\n'),
    );
    writeFileSync(envPath, [
      'KORDI_DEBUG_API_PORT=17081',
      'KORDI_CLOUD_RUNNER_TOKEN=synthetic-runner-token',
      'KORDI_CHAT_SYNC_CURSOR_SECRET=synthetic-cursor-secret',
      '',
    ].join('\n'), { mode: 0o600 });

    const run = () => spawnSync('bash', [join(repoRoot, 'scripts', 'dev-cloud-up.sh')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        KORDI_DEBUG_ENV_FILE: envPath,
        KORDI_DEBUG_PROJECT_NAME: 'kordi-secrets-test',
        KORDI_OMP_ROUTE_WORKER_TOKEN: 'must-not-reach-compose',
        KORDI_CLOUD_RUNNER_TOKEN: 'must-not-reach-compose',
        TEST_COMPOSE_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    const upgraded = run();
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(upgraded.stdout, /Added an isolated OMP route worker token/);
    assert.match(readFileSync(envPath, 'utf8'), /^KORDI_OMP_ROUTE_WORKER_TOKEN=synthetic-generated-secret$/m);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(capturePath, 'utf8').trim(), '|');

    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /Added an isolated OMP route worker token/);
    assert.equal(readFileSync(envPath, 'utf8').match(/^KORDI_OMP_ROUTE_WORKER_TOKEN=/gm)?.length, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the operator launcher never passes the worker token to the desktop process', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-operator-secrets-test-'));
  const binDir = join(tempRoot, 'bin');
  const capturePath = join(tempRoot, 'capture.txt');
  const allowlistPath = join(tempRoot, 'operator-github-allowlist.txt');
  try {
    mkdirSync(binDir);
    writeExecutable(join(binDir, 'gh'), '#!/bin/sh\nprintf \'example-maintainer\\n\'\n');
    writeExecutable(
      join(binDir, 'pnpm'),
      '#!/bin/sh\nprintf \'%s\\n\' "worker=${KORDI_OMP_ROUTE_WORKER_TOKEN:-}" > "$TEST_OPERATOR_CAPTURE"\n',
    );
    writeFileSync(allowlistPath, 'example-maintainer\n');

    const launched = spawnSync('bash', [join(repoRoot, 'scripts', 'dev-cloud-operator.sh'), 'https://kordi.ai'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        KORDI_OPERATOR_DEBUG_ACKNOWLEDGED: '1',
        KORDI_OPERATOR_GITHUB_ALLOWLIST_FILE: allowlistPath,
        KORDI_OMP_ROUTE_WORKER_TOKEN: 'must-not-reach-desktop',
        TEST_OPERATOR_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(readFileSync(capturePath, 'utf8').trim(), 'worker=');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('remote launcher and backend deploy clear the worker token from the parent shell', () => {
  const remote = read('scripts/dev-cloud-remote.sh');
  const deploy = read('scripts/backend_deploy_dev.py');

  assert.match(remote, /^unset KORDI_OMP_ROUTE_WORKER_TOKEN$/m);
  assert.ok(
    remote.indexOf('unset KORDI_OMP_ROUTE_WORKER_TOKEN') < remote.indexOf('dev:desktop:profile'),
    'the token is cleared before the desktop process starts',
  );
  assert.match(read('scripts/dev-cloud-up.sh'), /^unset KORDI_OMP_ROUTE_WORKER_TOKEN$/m);
  assert.match(read('scripts/dev-cloud-operator.sh'), /^unset KORDI_OMP_ROUTE_WORKER_TOKEN$/m);
  assert.match(deploy, /"KORDI_OMP_ROUTE_WORKER_TOKEN", "KORDI_CHAT_SYNC_CURSOR_SECRET"/);
});
