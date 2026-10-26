import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-js-chunk-budget.mjs', import.meta.url));

test('help gets a bounded on-demand allowance, never an exemption for startup code', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kordi-help-budget-'));
  const assets = path.join(root, 'assets');
  mkdirSync(assets);
  const run = () => spawnSync(process.execPath, [script, assets], { encoding: 'utf8' });
  try {
    writeFileSync(path.join(assets, 'index-test.js'), 'import("./HelpMenu-test.js");');
    writeFileSync(path.join(assets, 'HelpMenu-test.js'), 'import{a}from"./help-center-test.js";export{a};');
    writeFileSync(path.join(assets, 'help-center-test.js'), 'export const a=1;');
    writeFileSync(path.join(assets, 'HelpTour-test.js'), 'import{a}from"./help-center-test.js";export{a};');
    assert.equal(run().status, 0);
    writeFileSync(path.join(assets, 'index-test.js'), 'import{a}from"./help-center-test.js";');
    const eager = run();
    assert.notEqual(eager.status, 0);
    assert.match(eager.stderr, /imports it eagerly/);
    writeFileSync(path.join(assets, 'index-test.js'), 'import{a}from"./HelpMenu-test.js";');
    assert.notEqual(run().status, 0, 'the lazy entry must not be imported eagerly either');
    writeFileSync(path.join(assets, 'index-test.js'), 'import{a}from"./HelpTour-test.js";');
    assert.notEqual(run().status, 0, 'the tour entry must not be imported eagerly');
    writeFileSync(path.join(assets, 'index-test.js'), 'import("./HelpMenu-test.js");');
    writeFileSync(path.join(assets, 'help-center-test.css'), ' '.repeat(50_001));
    const oversized = run();
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /help center exceeds/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
