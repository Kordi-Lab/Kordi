import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
