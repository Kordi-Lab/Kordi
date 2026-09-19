import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(repoRoot, 'scripts/ci/select-checks.mjs');
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const nonHygieneIds = ['frontend', 'visual', 'browser', 'server', 'migrations', 'desktop', 'ios'];

function runSelection(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function manifestFrom(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function group(manifest, id) {
  const entry = manifest.groups.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing group ${id}`);
  return entry;
}

function changedFilesFixture(t, files) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kordi-select-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'changed-files.txt');
  writeFileSync(fixture, files.length > 0 ? `${files.join('\n')}\n` : '');
  return fixture;
}

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=ci@example.com', '-c', 'user.name=Kordi CI', ...args],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

test('documentation-only changes keep only hygiene applicable', (t) => {
  const fixture = changedFilesFixture(t, ['README.md', 'docs/ci-cd.md', '.github/assets/logo.png', 'LICENSE']);
  const manifest = manifestFrom(
    runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
  );
  assert.equal(manifest.version, 1);
  assert.equal(manifest.mode, 'diff');
  assert.equal(manifest.fallback, false);
  assert.equal(manifest.generatedBy, 'scripts/ci/select-checks.mjs');
  for (const id of nonHygieneIds) {
    assert.equal(group(manifest, id).applicable, false, id);
    assert.equal(group(manifest, id).reason, 'documentation-only change', id);
  }
  assert.equal(group(manifest, 'hygiene').applicable, true);
});

test('frontend-only changes select frontend, visual, and browser but not iOS', (t) => {
  const fixture = changedFilesFixture(t, ['app/desktop/src/App.tsx']);
  const manifest = manifestFrom(
    runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
  );
  for (const id of ['frontend', 'visual', 'browser', 'hygiene']) {
    assert.equal(group(manifest, id).applicable, true, id);
  }
  for (const id of ['server', 'migrations', 'desktop', 'ios']) {
    assert.equal(group(manifest, id).applicable, false, id);
  }
  assert.match(group(manifest, 'frontend').reason, /app\/desktop\/src\/App\.tsx/);
});

test('iOS-only changes select iOS and not frontend', (t) => {
  const fixture = changedFilesFixture(t, ['app/ios/Kordi/App.swift']);
  const manifest = manifestFrom(
    runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
  );
  assert.equal(group(manifest, 'ios').applicable, true);
  for (const id of ['frontend', 'visual', 'browser', 'server', 'migrations', 'desktop']) {
    assert.equal(group(manifest, id).applicable, false, id);
  }
  assert.equal(group(manifest, 'hygiene').applicable, true);
});

test('shared Rust dependency changes select server and desktop but not iOS', (t) => {
  const fixture = changedFilesFixture(t, ['agent/crates/core/src/lib.rs']);
  const manifest = manifestFrom(
    runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
  );
  assert.equal(group(manifest, 'server').applicable, true);
  assert.equal(group(manifest, 'desktop').applicable, true);
  assert.equal(group(manifest, 'ios').applicable, false);
  assert.equal(group(manifest, 'frontend').applicable, false);
});

test('shared lockfiles select every group', (t) => {
  for (const sharedPath of ['pnpm-lock.yaml', '.github/workflows/blocking-ci.yml', 'Cargo.lock']) {
    const fixture = changedFilesFixture(t, [sharedPath]);
    const manifest = manifestFrom(
      runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
    );
    for (const entry of manifest.groups) {
      assert.equal(entry.applicable, true, `${entry.id} for ${sharedPath}`);
      if (entry.id !== 'hygiene') {
        assert.match(entry.reason, /shared path changed/);
      }
    }
  }
});

test('unrecognized paths select every group conservatively', (t) => {
  const fixture = changedFilesFixture(t, ['some/unknown/file.bin']);
  const manifest = manifestFrom(
    runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]),
  );
  for (const entry of manifest.groups) {
    assert.equal(entry.applicable, true, entry.id);
    if (entry.id !== 'hygiene') {
      assert.match(entry.reason, /conservative full coverage/);
    }
  }
});

test('--all marks every group applicable', () => {
  const manifest = manifestFrom(runSelection(['--all', '--json']));
  assert.equal(manifest.mode, 'all');
  assert.equal(manifest.fallback, false);
  for (const entry of manifest.groups) {
    assert.equal(entry.applicable, true, entry.id);
    assert.match(entry.reason, /full suite requested/);
  }
});

test('deletions and renames keep affected groups applicable', (t) => {
  const directory = temporaryDirectory(t, 'kordi-select-git-');
  git(directory, ['init', '-q']);
  mkdirSync(path.join(directory, 'app/ios/Kordi'), { recursive: true });
  writeFileSync(path.join(directory, 'app/ios/Kordi/Old.swift'), 'let value = 1\n');
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-q', '-m', 'add iOS source']);
  const first = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['mv', 'app/ios/Kordi/Old.swift', 'app/ios/Kordi/New.swift']);
  git(directory, ['commit', '-q', '-m', 'rename iOS source']);
  const second = git(directory, ['rev-parse', 'HEAD']);
  const renamed = manifestFrom(
    runSelection(['--base', first, '--head', second, '--json'], directory),
  );
  assert.equal(renamed.base, first);
  assert.equal(renamed.head, second);
  assert.equal(group(renamed, 'ios').applicable, true);
  assert.equal(group(renamed, 'frontend').applicable, false);

  rmSync(path.join(directory, 'app/ios/Kordi/New.swift'));
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-q', '-m', 'delete iOS source']);
  const third = git(directory, ['rev-parse', 'HEAD']);
  const deleted = manifestFrom(
    runSelection(['--base', second, '--head', third, '--json'], directory),
  );
  assert.equal(group(deleted, 'ios').applicable, true);
  assert.equal(group(deleted, 'frontend').applicable, false);
});

test('diff failure falls back to conservative full coverage', (t) => {
  const directory = temporaryDirectory(t, 'kordi-select-fallback-');
  const result = runSelection(['--base', shaA, '--head', shaB, '--json'], directory);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.fallback, true);
  assert.equal(manifest.mode, 'diff');
  for (const entry of manifest.groups) {
    assert.equal(entry.applicable, true, entry.id);
    assert.match(entry.reason, /diff unavailable/);
  }
  assert.match(result.stderr, /warning/);
});

test('rejects malformed input with a non-zero exit', (t) => {
  const directory = temporaryDirectory(t, 'kordi-select-malformed-');
  const empty = path.join(directory, 'empty.txt');
  writeFileSync(empty, '\n');
  const absolute = path.join(directory, 'absolute.txt');
  writeFileSync(absolute, '/etc/passwd\n');
  const parent = path.join(directory, 'parent.txt');
  writeFileSync(parent, '../outside.txt\n');
  const cases = [
    ['unknown flag', ['--wat']],
    ['missing changed-files file', ['--changed-files', path.join(directory, 'missing.txt')]],
    ['empty changed-files file', ['--changed-files', empty]],
    ['absolute changed-files entry', ['--changed-files', absolute]],
    ['parent-directory changed-files entry', ['--changed-files', parent]],
    ['invalid base SHA', ['--base', 'not-a-sha', '--head', shaB]],
    ['missing base value', ['--base']],
  ];
  for (const [name, args] of cases) {
    const result = runSelection(args);
    assert.notEqual(result.status, 0, name);
    assert.notEqual(result.stderr.trim(), '', name);
  }
});

test('--changed-files output is deterministic and --out matches stdout', (t) => {
  const fixture = changedFilesFixture(t, ['app/desktop/src/App.tsx', 'app/ios/Kordi/App.swift']);
  const first = runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]);
  const second = runSelection(['--changed-files', fixture, '--json', '--base', shaA, '--head', shaB]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);

  const out = path.join(temporaryDirectory(t, 'kordi-select-out-'), 'manifest.json');
  const withOut = runSelection([
    '--changed-files',
    fixture,
    '--json',
    '--base',
    shaA,
    '--head',
    shaB,
    '--out',
    out,
  ]);
  assert.equal(withOut.status, 0, withOut.stderr);
  assert.equal(readFileSync(out, 'utf8'), withOut.stdout);
});

test('human-readable summary lists comparison and selected checks', (t) => {
  const fixture = changedFilesFixture(t, ['app/ios/Kordi/App.swift']);
  const result = runSelection(['--changed-files', fixture, '--base', shaA, '--head', shaB]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Comparison: ${shaA}\\.\\.\\.${shaB}`));
  assert.match(result.stdout, /Applicable checks:/);
  assert.match(result.stdout, /ios:/);
  assert.match(result.stdout, /Not applicable checks:/);
});
