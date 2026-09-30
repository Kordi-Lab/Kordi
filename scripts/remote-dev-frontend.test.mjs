import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('invalid remote preview frontend modes fail before connecting to a backend', () => {
  const result = spawnSync('bash', [fileURLToPath(new URL('./dev-cloud-remote.sh', import.meta.url))], {
    env: { ...process.env, KORDI_DEV_FRONTEND_MODE: 'invalid' },
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be development or production/);
  assert.doesNotMatch(result.stdout, /Opening an IAP tunnel/);
});

test('the shared connection restarts an exited tunnel without launching a desktop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kordi-connect-test-'));
  let child;
  try {
    await writeFile(join(directory, 'allowlist'), 'fixture-operator\n');
    await writeFile(join(directory, 'gh'), '#!/bin/sh\necho fixture-operator\n', { mode: 0o755 });
    await writeFile(join(directory, 'curl'), '#!/bin/sh\n[ -f "$CONNECT_TEST_DIR/alive" ] || exit 7\necho \'{"ok":true}\'\n', { mode: 0o755 });
    await writeFile(join(directory, 'pnpm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await writeFile(join(directory, 'gcloud'), `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.CONNECT_TEST_DIR;
let count = 0;
try { count = Number(fs.readFileSync(dir + '/count', 'utf8')); } catch {}
fs.writeFileSync(dir + '/count', String(++count));
fs.writeFileSync(dir + '/alive', '1');
process.on('SIGTERM', () => process.exit(0));
if (count === 1) setTimeout(() => { fs.unlinkSync(dir + '/alive'); process.exit(255); }, 1500);
else setInterval(() => {}, 1000);
`, { mode: 0o755 });
    child = spawn('bash', [fileURLToPath(new URL('./dev-cloud-remote.sh', import.meta.url))], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CONNECT_TEST_DIR: directory,
        KORDI_DEV_CONNECTION_MODE: 'connect', KORDI_DEV_FRONTEND_MODE: 'development',
        KORDI_DEV_GCP_PROJECT: 'fixture-project', KORDI_DEV_SSH_ZONE: 'fixture-zone', KORDI_DEV_SSH_TARGET: 'fixture-host',
        KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: join(directory, 'allowlist'), KORDI_DEV_PREVIEW_PATH: '/fixture' },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const deadline = Date.now() + 15000;
    let starts = 0;
    while (Date.now() < deadline) {
      starts = Number(await readFile(join(directory, 'count'), 'utf8').catch(() => '0'));
      if (starts >= 2 || child.exitCode !== null) break;
      await delay(50);
    }
    assert.equal(starts, 2, output);
    assert.equal(child.exitCode, null, output);
    assert.match(output, /Shared development connection ready/);
    assert.match(output, /shared IAP tunnel exited; reconnecting/);
    assert.doesNotMatch(output, /Launching the isolated desktop profile/);
  } finally {
    if (child?.pid && child.exitCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
