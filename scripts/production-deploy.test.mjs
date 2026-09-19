#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./production-deploy.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const IMAGE = `registry.example/kordi-cloud-server@${DIGEST}`;

function baseArguments(overrides = []) {
  return [
    '--sha', SHA,
    '--artifact', IMAGE,
    '--backup', 'snapshot-1',
    '--rollback-plan', 'redeploy the previous revision',
    '--schema-compatibility', 'additive migration; the previous binary remains compatible',
    '--actor', 'operator-one',
    '--project', 'example-project',
    '--zone', 'example-zone',
    '--ssh-target', 'example-instance',
    '--run-id', 'test-run',
    ...overrides,
  ];
}

function withoutFlag(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  if (index === -1) return arguments_;
  return [...arguments_.slice(0, index), ...arguments_.slice(index + 2)];
}

function runWrapper(arguments_, options = {}) {
  const result = spawnSync('bash', [scriptPath, ...arguments_], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withTempDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kordi-prod-deploy-test-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('dry run prints the lock, isolated commands, verification, and record steps', () => {
  const result = runWrapper(['--dry-run', ...baseArguments()]);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout;

  assert.match(output, /dry run: validating inputs only/);
  assert.match(output, /with-deploy-lock\.sh host-wide --timeout 1800/);
  assert.match(output, /KORDI_PRODUCTION_DEPLOY_LOCKED=1/);
  assert.match(output, /git -C .* rev-parse HEAD/);
  assert.match(output, /sync-and-build\.sh/);
  assert.match(output, /k3s\/deploy-cloud-server\.sh/);
  assert.match(output, /KORDI_CLOUD_REMOTE_DIR='\$HOME\/kordi-cloud-server-deploy\/prod-0123456789ab-test-run'/);
  assert.match(output, /KORDI_CLOUD_IMAGE_TAG=prod-0123456789ab-test-run/);
  assert.match(output, /gcloud compute ssh example-instance --zone example-zone --project example-project/);
  assert.match(output, /k3s ctr images ls/);
  assert.match(output, /rollout status deployment\/kordi-cloud-server/);
  assert.match(output, /127\.0\.0\.1:30081\/health/);
  assert.match(output, /https:\/\/kordi\.ai\/health/);
  assert.match(output, /record-deployment\.mjs/);
  assert.match(output, /--environment production/);
  assert.match(output, new RegExp(`--artifact ${DIGEST}`));
  assert.match(output, /--backup snapshot-1/);
  assert.match(output, /--out .*deploy\/deployment-records/);
  assert.doesNotMatch(output, /--rollback-plan[^\n]*--rollback-plan/);
});

test('each deployment run receives an isolated remote directory and image tag', () => {
  const first = runWrapper(['--dry-run', ...baseArguments()]);
  const second = runWrapper(['--dry-run', ...baseArguments(['--run-id', 'other-run'])]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /prod-0123456789ab-test-run/);
  assert.match(second.stdout, /prod-0123456789ab-other-run/);
  assert.doesNotMatch(second.stdout, /prod-0123456789ab-test-run/);
});

test('dry run never invokes gcloud', () => {
  withTempDirectory((directory) => {
    const marker = path.join(directory, 'gcloud-invoked');
    const shimDirectory = path.join(directory, 'bin');
    mkdirSync(shimDirectory);
    writeFileSync(
      path.join(shimDirectory, 'gcloud'),
      `#!/usr/bin/env bash\nprintf invoked > "${marker}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = runWrapper(['--dry-run', ...baseArguments()], {
      env: { PATH: `${shimDirectory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, 'gcloud must not run during a dry run');
  });
});

test('dry run does not create lock files or deployment records', () => {
  withTempDirectory((directory) => {
    const lockDirectory = path.join(directory, 'locks');
    const recordDirectory = path.join(directory, 'records');
    const result = runWrapper(
      ['--dry-run', ...baseArguments(['--record-dir', recordDirectory])],
      { env: { KORDI_DEPLOY_LOCK_DIR: lockDirectory } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(lockDirectory), false, 'dry run must not acquire locks');
    assert.equal(existsSync(recordDirectory), false, 'dry run must not write records');
  });
});

test('required environment identifiers are never inherited', () => {
  const missingProject = runWrapper(['--dry-run', ...withoutFlag(baseArguments(), '--project')]);
  assert.equal(missingProject.status, 2);
  assert.match(missingProject.stderr, /--project is required/);

  const missingZone = runWrapper(['--dry-run', ...baseArguments(['--zone', ''])]);
  assert.equal(missingZone.status, 2);
  assert.match(missingZone.stderr, /--zone is required/);

  const missingTarget = runWrapper(['--dry-run', ...baseArguments(['--ssh-target', ''])]);
  assert.equal(missingTarget.status, 2);
  assert.match(missingTarget.stderr, /--ssh-target is required/);
});

test('mutable or malformed artifacts fail closed before any host command', () => {
  const result = runWrapper(['--dry-run', ...baseArguments(['--artifact', 'kordi-cloud-server:latest'])]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /immutable sha256 digest/);
  assert.doesNotMatch(result.stdout, /gcloud compute ssh/);

  const shortDigest = runWrapper(['--dry-run', ...baseArguments(['--artifact', 'sha256:abc'])]);
  assert.equal(shortDigest.status, 1);
  assert.match(shortDigest.stderr, /immutable sha256 digest/);
});

test('malformed SHA, missing backup, and blank statements fail closed', () => {
  const badSha = runWrapper(['--dry-run', ...baseArguments(['--sha', 'not-a-sha'])]);
  assert.equal(badSha.status, 1);
  assert.match(badSha.stderr, /sha must be a full 40-character/);

  const missingBackup = runWrapper(['--dry-run', ...baseArguments(['--backup', ''])]);
  assert.equal(missingBackup.status, 2);
  assert.match(missingBackup.stderr, /--backup is required/);

  const blankPlan = runWrapper(['--dry-run', ...baseArguments(['--rollback-plan', '   '])]);
  assert.equal(blankPlan.status, 1);
  assert.match(blankPlan.stderr, /rollback plan must be a non-empty statement/);

  const blankCompatibility = runWrapper([
    '--dry-run',
    ...baseArguments(['--schema-compatibility', '']),
  ]);
  assert.equal(blankCompatibility.status, 2);
  assert.match(blankCompatibility.stderr, /--schema-compatibility is required/);
});

test('usage errors are reported for unknown options and bad timeouts', () => {
  const unknown = runWrapper(['--dry-run', ...baseArguments(), '--unknown-flag']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option/);

  const badTimeout = runWrapper(['--dry-run', ...baseArguments(['--lock-timeout', 'soon'])]);
  assert.equal(badTimeout.status, 2);
  assert.match(badTimeout.stderr, /--lock-timeout must be a non-negative integer/);

  const badRunId = runWrapper(['--dry-run', ...baseArguments(['--run-id', 'bad id'])]);
  assert.equal(badRunId.status, 2);
  assert.match(badRunId.stderr, /--run-id must contain only/);
});

test('a source tree at the wrong revision fails closed before any host command', () => {
  withTempDirectory((directory) => {
    const marker = path.join(directory, 'gcloud-invoked');
    const shimDirectory = path.join(directory, 'bin');
    const recordDirectory = path.join(directory, 'records');
    mkdirSync(shimDirectory);
    writeFileSync(
      path.join(shimDirectory, 'gcloud'),
      `#!/usr/bin/env bash\nprintf invoked > "${marker}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = runWrapper(baseArguments(['--source-root', directory, '--record-dir', recordDirectory]), {
      env: {
        PATH: `${shimDirectory}:${process.env.PATH}`,
        KORDI_PRODUCTION_DEPLOY_LOCKED: '1',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to sync a different revision/);
    assert.equal(existsSync(marker), false, 'gcloud must not run when the revision does not match');
  });
});

test('confirm phrase is validated when provided', () => {
  const wrongConfirm = runWrapper(['--dry-run', ...baseArguments(['--confirm', 'yes'])]);
  assert.equal(wrongConfirm.status, 1);
  assert.match(wrongConfirm.stderr, /confirm must be exactly "deploy-production"/);

  const rightConfirm = runWrapper([
    '--dry-run',
    ...baseArguments(['--confirm', 'deploy-production']),
  ]);
  assert.equal(rightConfirm.status, 0, rightConfirm.stderr);
});
