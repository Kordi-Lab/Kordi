import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../scripts/launch-cloud-multi.mjs', import.meta.url), 'utf8');

test('cloud multi launcher defaults tunnel test runs to the gcloud tunnel API', () => {
  assert.match(source, /const localTunnelEnabled = process\.env\.KORDI_CLOUD_USE_LOCAL_TUNNEL === '1';/);
  assert.match(source, /localTunnelEnabled\s*\? `http:\/\/127\.0\.0\.1:\$\{LOCAL_PORT\}`\s*:\s*DEFAULT_CLOUD_API_BASE/s);
});

test('cloud multi launcher uses the takotako k3s tunnel path with keepalives', () => {
  assert.match(source, /KORDI_CLOUD_SSH_TARGET \?\? 'shu_yang@takotako'/);
  assert.match(source, /KORDI_CLOUD_SSH_ZONE \?\? 'us-central1-c'/);
  assert.match(source, /KORDI_CLOUD_VM_PORT \?\? '17088'/);
  assert.match(source, /ExitOnForwardFailure=yes/);
  assert.match(source, /ServerAliveInterval=15/);
  assert.match(source, /ServerAliveCountMax=3/);
});
