import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('offline emoji artwork has a bounded allowance without expanding the general app budget', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kordi-asset-budget-'));
  const assets = path.join(root, 'assets');
  mkdirSync(assets);
  const check = () => spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/check-js-chunk-budget.mjs', import.meta.url)), assets,
  ], { encoding: 'utf8', env: { ...process.env, KORDI_MAX_JS_CHUNK_BYTES: '700000', KORDI_MAX_DESKTOP_DIST_BYTES: '5000000' } });
  try {
    writeFileSync(path.join(assets, 'main.js'), 'export {};');
    writeFileSync(path.join(assets, 'application.css'), Buffer.alloc(4_999_000));
    writeFileSync(path.join(assets, 'atlas-0-example.webp'), Buffer.alloc(2_500_000));
    assert.equal(check().status, 0);
    writeFileSync(path.join(assets, 'unrelated.bin'), Buffer.alloc(2_000));
    assert.notEqual(check().status, 0, 'unrelated assets retain the original 5 MB cap');
    rmSync(path.join(assets, 'unrelated.bin'));
    writeFileSync(path.join(assets, 'atlas-0-example.webp'), Buffer.alloc(2_600_001));
    assert.notEqual(check().status, 0, 'emoji artwork cannot exceed its own cap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
