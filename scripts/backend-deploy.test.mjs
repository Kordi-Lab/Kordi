import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('backend bundle integrity, host deployment, and failure records', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_backend_*.py', '-v'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
