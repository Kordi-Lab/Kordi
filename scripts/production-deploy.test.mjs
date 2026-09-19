import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production wrapper explains the protected promotion interface', () => {
  const result = spawnSync('bash', ['scripts/production-deploy.sh', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verified-bundle-directory/);
  assert.match(result.stdout, /requires approval/);
});
test('legacy source-rebuild arguments are rejected before host access', () => {
  const result = spawnSync('bash', ['scripts/production-deploy.sh', '--sha', 'a'.repeat(40)], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});
