import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./backend-configuration.mjs', import.meta.url));
const example = fileURLToPath(new URL('../shared/configuration/examples/app.example.json', import.meta.url));
const argumentsFor = (file = example) => [
  '--config', file, '--edition', 'app', '--environment', 'production',
  '--expected-backend-origin', 'https://app.example.test',
];
const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

function directory(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kordi-configuration-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('validation is read-only and independent of process environment defaults', (t) => {
  const root = directory(t);
  const result = spawnSync(process.execPath, [script, ...argumentsFor()], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, VITE_KORDI_CLOUD_API_BASE: 'https://unrelated.example.test' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No files changed or deployment performed/);
  assert.deepEqual(readdirSync(root), []);
});

test('generation creates backend-only artifacts without rewriting the input', (t) => {
  const root = directory(t);
  const config = path.join(root, 'candidate.json');
  const contents = readFileSync(example, 'utf8');
  writeFileSync(config, contents);
  const result = run([...argumentsFor(config), '--output-dir', path.join(root, 'generated')], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(config, 'utf8'), contents);
  assert.deepEqual(readdirSync(path.join(root, 'generated')).sort(), ['backend.json', 'desktop.env', 'manifest.json', 'runner.env']);
  assert.equal(readFileSync(path.join(root, 'generated', 'desktop.env'), 'utf8'), 'VITE_KORDI_CLOUD_API_BASE=https://app.example.test\n');
});

test('invoking the CLI through a symlink still validates and rejects invalid input', (t) => {
  const root = directory(t);
  const alias = path.join(root, 'configuration.mjs');
  symlinkSync(script, alias);
  const result = spawnSync(process.execPath, [alias, ...argumentsFor()], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Backend configuration validated/);
  const invalid = spawnSync(process.execPath, [alias, '--deploy'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});

test('invalid or mismatched input never creates output and diagnostics redact contents and paths', (t) => {
  const root = directory(t);
  const config = path.join(root, 'synthetic-sensitive-filename.json');
  for (const contents of ['{"secret":"synthetic-secret"}', 'synthetic-secret',
    readFileSync(example, 'utf8').replace('"app"', '"research"')]) {
    writeFileSync(config, contents);
    const result = run([...argumentsFor(config), '--output-dir', path.join(root, 'generated')], root);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|synthetic-sensitive-filename/);
    assert.deepEqual(readdirSync(root), ['synthetic-sensitive-filename.json']);
  }
});

test('existing directories and symlinks are never overwritten', (t) => {
  const root = directory(t);
  const marker = path.join(root, 'preserve.txt');
  writeFileSync(marker, 'preserve');
  const link = path.join(root, 'link');
  symlinkSync(root, link, 'dir');
  for (const output of [root, link, example]) {
    const result = run([...argumentsFor(), '--output-dir', output], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /new output directory/);
  }
  assert.equal(readFileSync(marker, 'utf8'), 'preserve');
  assert.deepEqual(readdirSync(root).sort(), ['link', 'preserve.txt']);
});

test('explicit complete target is mandatory and unexpected CLI arguments fail closed', (t) => {
  const root = directory(t);
  for (const args of [[], ['--config', example], [...argumentsFor(), '--edition', 'research'],
    [...argumentsFor(), '--deploy'], [...argumentsFor(), '--output-dir'],
    [...argumentsFor().slice(0, 2), '--edition', 'beta', ...argumentsFor().slice(4)]]) {
    assert.equal(run(args, root).status, 1);
  }
  const missing = run(argumentsFor(path.join(root, 'synthetic-sensitive-missing.json')), root);
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /synthetic-sensitive-missing/);
  assert.equal(run(['--help'], root).status, 0);
  assert.deepEqual(readdirSync(root), []);
});
