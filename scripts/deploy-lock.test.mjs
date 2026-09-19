#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const libPath = join(repoRoot, 'scripts/lib/deploy-lock.sh');
const wrapperPath = join(repoRoot, 'scripts/with-deploy-lock.sh');
const hasFlock = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;

function makeLockDir() {
  return mkdtempSync(join(tmpdir(), 'kordi-deploy-lock-test-'));
}

function lockEnv(directory, extra = {}) {
  return {
    ...process.env,
    KORDI_DEPLOY_LOCK_DIR: directory,
    KORDI_TEST_LIB: libPath,
    ...extra,
  };
}

function runLockScript(script, directory, extra = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$KORDI_TEST_LIB"\n${script}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    env: lockEnv(directory, extra),
  });
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForOutput(read, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(marker)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for output: ${marker}`);
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('child did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function startHolder(directory, name, holdSeconds, extra = {}) {
  const script = [
    'set -euo pipefail',
    'source "$KORDI_TEST_LIB"',
    `kordi_deploy_lock ${JSON.stringify(name)} 10`,
    'echo holder-ready',
    `sleep ${holdSeconds}`,
  ].join('\n');
  const child = spawn('bash', ['-c', script], {
    cwd: repoRoot,
    env: lockEnv(directory, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function readOwnerPid(directory, name) {
  const owner = fs.readFileSync(join(directory, `${name}.owner`), 'utf8');
  const match = /^pid=(\d+)$/m.exec(owner);
  assert.ok(match, `owner metadata missing pid:\n${owner}`);
  return match[1];
}

test('shell entrypoints pass bash syntax validation', () => {
  const result = spawnSync('bash', ['-n', libPath, wrapperPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('acquires a lock, writes owner metadata, and releases it', () => {
  const directory = makeLockDir();
  try {
    const result = runLockScript(`
kordi_deploy_lock test-lock 5
cat "${directory}/test-lock.owner"
kordi_deploy_unlock test-lock
test ! -f "${directory}/test-lock.owner"
echo release-verified
`, directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^lock=test-lock$/m);
    assert.match(result.stdout, /^host=.+$/m);
    assert.match(result.stdout, /^user=.+$/m);
    assert.match(result.stdout, /^pid=\d+$/m);
    assert.match(result.stdout, /^acquired_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    assert.match(result.stdout, /release-verified/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent acquisition times out immediately with holder metadata', async () => {
  const directory = makeLockDir();
  const holder = startHolder(directory, 'test-lock', 3);
  try {
    await waitForFile(join(directory, 'test-lock.owner'));
    const result = runLockScript('kordi_deploy_lock test-lock 0', directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Timed out after 0s waiting for lock 'test-lock'/);
    assert.match(result.stderr, /Current owner metadata/);
    assert.match(result.stderr, /pid=\d+/);
    assert.match(result.stderr, /Do not delete/);
  } finally {
    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent acquisition honors a positive timeout and then succeeds', async () => {
  const directory = makeLockDir();
  const holder = startHolder(directory, 'test-lock', 4);
  try {
    await waitForFile(join(directory, 'test-lock.owner'));
    const startedAt = Date.now();
    const blocked = runLockScript('kordi_deploy_lock test-lock 1', directory);
    const elapsed = Date.now() - startedAt;
    assert.notEqual(blocked.status, 0);
    assert.ok(elapsed >= 900, `expected to wait about a second, waited ${elapsed}ms`);
    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);
    const acquired = runLockScript('kordi_deploy_lock test-lock 5', directory);
    assert.equal(acquired.status, 0, acquired.stderr);
  } finally {
    holder.child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release makes the lock available to the next process', () => {
  const directory = makeLockDir();
  try {
    const first = runLockScript('kordi_deploy_lock release-test 5\nkordi_deploy_unlock release-test', directory);
    assert.equal(first.status, 0, first.stderr);
    const second = runLockScript('kordi_deploy_lock release-test 2\necho second-acquired', directory);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /second-acquired/);
    assert.match(second.stderr, new RegExp(`backend=${hasFlock ? 'flock' : 'portable'}`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lock is released when the holder is killed', async () => {
  const directory = makeLockDir();
  const holder = startHolder(directory, 'crash-test', 30);
  try {
    await waitForFile(join(directory, 'crash-test.owner'));
    const deadPid = readOwnerPid(directory, 'crash-test');
    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);
    const result = runLockScript(
      'kordi_deploy_lock crash-test 5\ncat "$KORDI_DEPLOY_LOCK_DIR/crash-test.owner"',
      directory,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(readOwnerPid(directory, 'crash-test'), deadPid);
    assert.doesNotMatch(result.stdout, new RegExp(`^pid=${deadPid}$`, 'm'));
  } finally {
    holder.child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable backend replaces stale metadata and never breaks a live lock', async () => {
  const directory = makeLockDir();
  const portable = { KORDI_DEPLOY_LOCK_FORCE_PORTABLE: '1' };
  const holder = startHolder(directory, 'live-lock', 3, portable);
  try {
    const stale = runLockScript(`
mkdir -p "$KORDI_DEPLOY_LOCK_DIR"
printf 'lock=stale-lock\\nhost=%s\\nuser=tester\\npid=999999\\nacquired_at=2026-01-01T00:00:00Z\\n' "$(hostname)" > "$KORDI_DEPLOY_LOCK_DIR/stale-lock.lock"
`, directory, portable);
    assert.equal(stale.status, 0, stale.stderr);
    const acquired = runLockScript('kordi_deploy_lock stale-lock 3', directory, portable);
    assert.equal(acquired.status, 0, acquired.stderr);
    assert.match(acquired.stderr, /backend=portable/);

    const hostname = spawnSync('hostname', { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(
      join(directory, 'live-owner.lock'),
      `lock=live-owner\nhost=${hostname}\nuser=tester\npid=${process.pid}\nacquired_at=2026-01-01T00:00:00Z\n`,
    );
    const liveOwner = runLockScript('kordi_deploy_lock live-owner 0', directory, portable);
    assert.notEqual(liveOwner.status, 0);
    assert.equal(fs.existsSync(join(directory, 'live-owner.lock')), true);

    fs.writeFileSync(join(directory, 'empty-lock.lock'), '');
    const recovered = runLockScript('kordi_deploy_lock empty-lock 3', directory, portable);
    assert.equal(recovered.status, 0, recovered.stderr);

    await waitForFile(join(directory, 'live-lock.owner'));
    const livePid = readOwnerPid(directory, 'live-lock');
    const blocked = runLockScript('kordi_deploy_lock live-lock 0', directory, portable);
    assert.notEqual(blocked.status, 0);
    assert.match(fs.readFileSync(join(directory, 'live-lock.lock'), 'utf8'), new RegExp(`^pid=${livePid}$`, 'm'));
    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);
  } finally {
    holder.child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one process can hold a stack lock and the host-wide lock together', () => {
  const directory = makeLockDir();
  try {
    const result = runLockScript(`
kordi_deploy_lock stack-42 5
kordi_deploy_lock host-wide 5
echo both-held
kordi_deploy_unlock stack-42
kordi_deploy_unlock host-wide
`, directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /both-held/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('library rejects invalid lock names and timeouts', () => {
  const directory = makeLockDir();
  try {
    for (const script of [
      'kordi_deploy_lock "" 5',
      'kordi_deploy_lock "../escape" 5',
      'kordi_deploy_lock ".hidden" 5',
      'kordi_deploy_lock "stack test" 5',
      'kordi_deploy_lock host-wide abc',
      'kordi_deploy_lock host-wide -1',
    ]) {
      const result = runLockScript(script, directory);
      assert.equal(result.status, 2, `${script}: ${result.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creates the lock directory when missing', () => {
  const parent = makeLockDir();
  const directory = join(parent, 'nested', 'locks');
  try {
    const result = runLockScript('kordi_deploy_lock mkdir-test 5\necho ok', directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(join(directory, 'mkdir-test.owner')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('selects flock when available and portable when forced', () => {
  const directory = makeLockDir();
  try {
    const natural = runLockScript('kordi_deploy_lock backend-test 5', directory);
    assert.equal(natural.status, 0, natural.stderr);
    assert.match(natural.stderr, new RegExp(`backend=${hasFlock ? 'flock' : 'portable'}`));
    const forced = runLockScript('kordi_deploy_lock backend-portable 5', directory, {
      KORDI_DEPLOY_LOCK_FORCE_PORTABLE: '1',
    });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stderr, /backend=portable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrapper propagates the command exit code and releases the lock', () => {
  const directory = makeLockDir();
  try {
    const failed = spawnSync(
      'bash',
      [wrapperPath, 'wrapper-test', '--timeout', '5', '--', 'bash', '-c', 'exit 7'],
      { cwd: repoRoot, encoding: 'utf8', env: lockEnv(directory) },
    );
    assert.equal(failed.status, 7, failed.stderr);
    const succeeded = spawnSync(
      'bash',
      [wrapperPath, 'wrapper-test', '--timeout', '5', '--', 'bash', '-c', 'echo wrapped-ok'],
      { cwd: repoRoot, encoding: 'utf8', env: lockEnv(directory) },
    );
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.match(succeeded.stdout, /wrapped-ok/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrapper holds the lock while the command runs', async () => {
  const directory = makeLockDir();
  const child = spawn(
    'bash',
    [wrapperPath, 'wrapper-hold', '--timeout', '10', '--', 'bash', '-c', 'echo started; sleep 3'],
    { cwd: repoRoot, env: lockEnv(directory), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  try {
    await waitForOutput(() => stdout, 'started');
    const blocked = runLockScript('kordi_deploy_lock wrapper-hold 0', directory);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Timed out/);
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrapper rejects invalid usage', () => {
  const directory = makeLockDir();
  try {
    const cases = [
      { args: [], pattern: /Missing lock name/ },
      { args: ['stack-test'], pattern: /Missing '-- <command/ },
      { args: ['stack-test', '--timeout'], pattern: /--timeout requires a value/ },
      { args: ['stack-test', '--timeout', '5', '--'], pattern: /Missing '-- <command/ },
      { args: ['stack-test', '--unknown', '--', 'true'], pattern: /Unknown option/ },
      { args: ['../escape', '--timeout', '1', '--', 'true'], pattern: /Invalid lock name/ },
    ];
    for (const { args, pattern } of cases) {
      const result = spawnSync('bash', [wrapperPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: lockEnv(directory),
      });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
