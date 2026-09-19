#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptPath = join(repoRoot, 'scripts/dev-deploy-stack.sh');
const lockHelperPath = join(repoRoot, 'scripts/with-deploy-lock.sh');
const SHA = 'b'.repeat(40);

function runAllocationStep(context, response) {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-allocation-workflow-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(join(directory, 'scripts'));
  fs.mkdirSync(join(directory, 'deploy/dev'), { recursive: true });
  const allocator = join(directory, 'scripts/dev-stack-allocate.mjs');
  if (response === undefined) {
    fs.copyFileSync(join(repoRoot, 'scripts/dev-stack-allocate.mjs'), allocator);
  } else {
    writeFileSync(allocator, `console.log(${JSON.stringify(JSON.stringify(response))});\n`);
  }
  writeFileSync(join(directory, 'deploy/dev/stack-allocations.json'), JSON.stringify({
    version: 1,
    stacks: [{ id: 'issue-1234', owner: 'developer-one', createdAt: '2026-01-01T00:00:00Z' }],
  }));
  const workflow = fs.readFileSync(join(repoRoot, '.github/workflows/deploy-dev.yml'), 'utf8');
  const match = workflow.match(/      - name: Validate stack allocation\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/);
  assert.ok(match, 'allocation step must exist');
  const script = match[1].replace(/^          /gm, '');
  const outputFile = join(directory, 'outputs');
  writeFileSync(outputFile, 'existing=preserved\n');
  const result = spawnSync('bash', ['-c', script], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile,
      STACK_ID: 'issue-1234', ACTOR: 'developer-one' },
  });
  return { ...result, outputs: fs.readFileSync(outputFile, 'utf8'), directory };
}

test('workflow consumes the real allocator JSON and passes the deployment guard', (context) => {
  const result = runAllocationStep(context);
  assert.equal(result.status, 0, result.stderr);
  const { plan } = JSON.parse(fs.readFileSync(join(result.directory, 'dev-stack-plan.json'), 'utf8'));
  const outputs = Object.fromEntries(result.outputs.trim().split('\n').map((line) => line.split('=')));
  assert.deepEqual(outputs, {
    existing: 'preserved', compose_project: 'kordi-issue-1234', lock: 'stack-issue-1234',
    api_port: String(plan.ports.api), minio_port: String(plan.ports.minio),
    minio_console_port: String(plan.ports.minioConsole),
  });
  const deploy = runTransport(['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run'], {
    KORDI_DEV_STACK_PROJECT: outputs.compose_project,
    KORDI_DEV_API_PORT: outputs.api_port,
    KORDI_DEV_MINIO_PORT: outputs.minio_port,
    KORDI_DEV_MINIO_CONSOLE_PORT: outputs.minio_console_port,
  });
  assert.equal(deploy.status, 0, deploy.stderr);
});

test('workflow rejects missing or malformed plan fields before publishing any outputs', (context) => {
  const plan = { composeProject: 'kordi-issue-1234', lock: 'stack-issue-1234',
    ports: { api: 17142, minio: 19142, minioConsole: 20142 } };
  for (const response of [
    { ok: true, ...plan },
    { ok: false, plan },
    { ok: true, plan: { ...plan, lock: null } },
    { ok: true, plan: { ...plan, ports: { ...plan.ports, minioConsole: null } } },
    { ok: true, plan: { ...plan, ports: { ...plan.ports, api: 'null' } } },
  ]) {
    const result = runAllocationStep(context, response);
    assert.notEqual(result.status, 0, JSON.stringify(response));
    assert.equal(result.outputs, 'existing=preserved\n');
  }
});

const baseEnv = Object.freeze({
  KORDI_DEV_GCP_PROJECT: 'test-project-123456',
  KORDI_DEV_SSH_ZONE: 'test-zone-a',
  KORDI_DEV_SSH_TARGET: 'test-dev-instance',
  KORDI_DEV_STACK_ROOT: '/srv/kordi/stacks',
  KORDI_DEV_STACK_PROJECT: 'kordi-issue-1234',
  KORDI_DEV_API_PORT: '17142',
  KORDI_DEV_MINIO_PORT: '19142',
  KORDI_DEV_MINIO_CONSOLE_PORT: '20142',
  KORDI_DEV_REPOSITORY_URL: 'https://github.com/example/kordi.git',
  KORDI_DEV_LOCK_TIMEOUT: '1800',
});

function runTransport(args, overrides = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...baseEnv, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync('bash', [scriptPath, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

test('deploy dry run prints the host lock and the exact remote commands', () => {
  const result = runTransport(['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stack-issue-1234 --timeout 1800/);
  assert.match(result.stdout, /--tunnel-through-iap/);
  assert.match(result.stdout, /--project test-project-123456/);
  assert.match(result.stdout, /--zone test-zone-a/);
  assert.match(result.stdout, /test-dev-instance/);
  assert.match(result.stdout, new RegExp(`checkout --detach ${SHA}`));
  assert.match(result.stdout, /KORDI_DEBUG_PROJECT_NAME=kordi-issue-1234/);
  assert.match(result.stdout, /\/srv\/kordi\/stacks\/issue-1234/);
  assert.match(result.stdout, /bash scripts\/dev-cloud-up\.sh/);
  assert.match(result.stdout, /KORDI_DEV_ARTIFACT_DIGEST/);
  assert.doesNotMatch(result.stdout, /dev-cloud-reset/);
  assert.doesNotMatch(result.stdout, /down --volumes/);
  assert.doesNotMatch(result.stdout, /--remove-orphans/);
});

test('smoke dry run targets the same stack lock and smoke script', () => {
  const result = runTransport(['smoke', '--stack', 'issue-1234', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stack-issue-1234 --timeout 1800/);
  assert.match(result.stdout, /bash scripts\/dev-cloud-smoke\.sh/);
  assert.match(result.stdout, /KORDI_DEBUG_PROJECT_NAME=kordi-issue-1234/);
});

test('cleanup requires explicit destructive-action authorization', () => {
  const missing = runTransport(['cleanup', '--stack', 'issue-1234', '--dry-run']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--confirm-stack/);

  const mismatch = runTransport(['cleanup', '--stack', 'issue-1234', '--confirm-stack', 'issue-9999', '--dry-run']);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /refusing to clean another stack/);

  const confirmed = runTransport(['cleanup', '--stack', 'issue-1234', '--confirm-stack', 'issue-1234', '--dry-run']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /docker compose --project-name kordi-issue-1234/);
  assert.match(confirmed.stdout, /down --remove-orphans/);
  assert.doesNotMatch(confirmed.stdout, /--volumes/);
});

test('missing explicit identifiers fail closed instead of inheriting defaults', () => {
  for (const name of [
    'KORDI_DEV_GCP_PROJECT',
    'KORDI_DEV_SSH_ZONE',
    'KORDI_DEV_SSH_TARGET',
    'KORDI_DEV_STACK_ROOT',
    'KORDI_DEV_STACK_PROJECT',
    'KORDI_DEV_API_PORT',
    'KORDI_DEV_MINIO_PORT',
    'KORDI_DEV_MINIO_CONSOLE_PORT',
    'KORDI_DEV_REPOSITORY_URL',
  ]) {
    const result = runTransport(['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run'], { [name]: undefined });
    assert.notEqual(result.status, 0, `expected failure without ${name}`);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('invalid stack identifiers and revisions are rejected', () => {
  for (const stack of ['Issue-1234', 'issue_1234', 'issue.1234', '-issue', 'issue-', 'issue--1234', 'a', 'a'.repeat(33)]) {
    const result = runTransport(['deploy', '--stack', stack, '--sha', SHA, '--dry-run']);
    assert.notEqual(result.status, 0, `expected rejection of ${stack}`);
    assert.match(result.stderr, /stack id/);
  }
  for (const sha of ['', 'abc', 'B'.repeat(40)]) {
    const result = runTransport(['deploy', '--stack', 'issue-1234', '--sha', sha, '--dry-run']);
    assert.notEqual(result.status, 0);
  }
});

test('a mismatched compose project is refused', () => {
  const result = runTransport(
    ['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run'],
    { KORDI_DEV_STACK_PROJECT: 'kordi-issue-9999' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /kordi-issue-1234/);
  assert.match(result.stderr, /another stack/);
});

test('duplicate ports are refused', () => {
  const result = runTransport(
    ['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run'],
    { KORDI_DEV_MINIO_PORT: '17142' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /distinct/);
});

test('usage errors exit with status 2', () => {
  assert.equal(runTransport([]).status, 2);
  assert.equal(runTransport(['deploy', '--stack', 'issue-1234']).status, 2);
  assert.equal(runTransport(['deploy', '--stack', 'issue-1234', '--sha', SHA, '--unknown']).status, 2);
});

test('dry run never executes the transport binary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-dev-deploy-test-'));
  try {
    const marker = join(directory, 'executed');
    const fakeGcloud = join(directory, 'fake-gcloud');
    writeFileSync(fakeGcloud, `#!/usr/bin/env bash\nprintf 'executed' > ${JSON.stringify(marker)}\n`);
    fs.chmodSync(fakeGcloud, 0o755);
    const result = runTransport(
      ['deploy', '--stack', 'issue-1234', '--sha', SHA, '--dry-run'],
      { KORDI_DEV_GCLOUD_BIN: fakeGcloud },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real transport runs through the host-side lock wrapper', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-dev-deploy-test-'));
  try {
    const argsFile = join(directory, 'gcloud-args');
    const fakeGcloud = join(directory, 'fake-gcloud');
    writeFileSync(fakeGcloud, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
    fs.chmodSync(fakeGcloud, 0o755);
    const result = runTransport(
      ['smoke', '--stack', 'issue-1234'],
      { KORDI_DEV_GCLOUD_BIN: fakeGcloud },
    );
    if (!fs.existsSync(lockHelperPath)) {
      context.diagnostic('shared lock helper is not present in this checkout; asserting fail-closed behavior');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing shared lock helper/);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const args = fs.readFileSync(argsFile, 'utf8');
    assert.match(args, /--tunnel-through-iap/);
    assert.match(args, /--project\ntest-project-123456/);
    const commandMatch = /printf %s ([A-Za-z0-9+/=]+) \| base64 --decode \| bash/.exec(args);
    assert.ok(commandMatch, `missing base64 command in:\n${args}`);
    const bootstrap = Buffer.from(commandMatch[1], 'base64').toString('utf8');
    assert.match(bootstrap, /with-deploy-lock\.sh/);
    assert.match(bootstrap, /stack-issue-1234/);
    assert.match(bootstrap, /--timeout 1800/);
    assert.match(bootstrap, /dev-cloud-smoke\.sh/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Execute the generated checkout section against a real synthetic Git repository.
test('a newly allocated stack checks out successfully and existing dirty files remain protected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-dev-first-checkout-'));
  try {
    const seed = join(directory, 'seed');
    fs.mkdirSync(seed);
    const git = (...args) => {
      const result = spawnSync('git', args, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q', seed);
    writeFileSync(join(seed, 'fixture.txt'), 'synthetic source\n');
    git('-C', seed, 'add', '.');
    git('-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
    const sha = git('-C', seed, 'rev-parse', 'HEAD');
    const root = join(directory, 'stacks');
    const result = runTransport(['deploy', '--stack', 'issue-1234', '--sha', sha, '--dry-run'], { KORDI_DEV_STACK_ROOT: root });
    assert.equal(result.status, 0, result.stderr);
    const marker = '[dev-deploy] remote script for stack issue-1234:\n';
    const script = result.stdout.split(marker)[1].split('\ncd "$stack_dir"')[0]
      .replaceAll(baseEnv.KORDI_DEV_REPOSITORY_URL, seed);
    const first = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(root, 'issue-1234', 'fixture.txt'), 'local work\n');
    const second = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /local changes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
