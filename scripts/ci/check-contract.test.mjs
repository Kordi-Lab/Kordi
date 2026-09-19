import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHARED_PATHS, loadInventory } from './select-checks.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runCheck = path.join(repoRoot, 'scripts/ci/run-check.mjs');
const selectChecks = path.join(repoRoot, 'scripts/ci/select-checks.mjs');
const requiredGroupIds = ['frontend', 'visual', 'browser', 'server', 'migrations', 'desktop', 'ios', 'hygiene'];
const expectedSharedPaths = [
  'pnpm-lock.yaml',
  'Cargo.lock',
  'package.json',
  'Cargo.toml',
  'rust-toolchain*',
  'pnpm-workspace.yaml',
  'tsconfig*.json',
  '.github/workflows/**',
  'scripts/ci/**',
  'scripts/prepare-ci-postgres.sh',
  'scripts/test-cloud-migrations.sh',
  'scripts/prepare-tauri-sidecar-placeholders.sh',
];
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const scripts = packageJson.scripts;

function spawnNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

test('inventory parses with a supported version', () => {
  const inventory = loadInventory();
  assert.equal(inventory.version, 1);
  assert.ok(Array.isArray(inventory.groups));
  assert.equal(inventory.groups.length, requiredGroupIds.length);
});

test('every required group id appears exactly once in the documented order', () => {
  const ids = loadInventory().groups.map((group) => group.id);
  assert.deepEqual(ids, requiredGroupIds);
  assert.equal(new Set(ids).size, ids.length);
});

test('every group declares a workflow, command, runner, and expected outputs', () => {
  for (const group of loadInventory().groups) {
    assert.match(group.workflow, /^[a-z0-9-]+\.yml$/, group.id);
    assert.ok(group.command.trim().length > 0, group.id);
    assert.ok(group.runner.trim().length > 0, group.id);
    assert.ok(group.title.trim().length > 0, group.id);
    assert.ok(Array.isArray(group.outputs) && group.outputs.length > 0, group.id);
    assert.ok(group.outputs.every((output) => output.trim().length > 0), group.id);
    assert.ok(Number.isInteger(group.timeoutMinutes) && group.timeoutMinutes > 0, group.id);
    assert.equal(typeof group.always, 'boolean', group.id);
    assert.equal(typeof group.serial, 'boolean', group.id);
    assert.ok(Array.isArray(group.paths), group.id);
    if (!group.always) {
      assert.ok(group.paths.length > 0, group.id);
    }
  }
});

test('every group command maps to a non-empty package.json script', () => {
  for (const group of loadInventory().groups) {
    const match = group.command.match(/^pnpm ([a-z0-9:_-]+)$/);
    assert.ok(match, `${group.id} command must be a pnpm script: ${group.command}`);
    const script = scripts[match[1]];
    assert.ok(script, `${group.id} references missing package.json script ${match[1]}`);
    assert.ok(script.trim().length > 0, `${group.id} script ${match[1]} is empty`);
  }
});

test('package.json script references resolve to existing scripts', () => {
  const builtins = new Set([
    'exec', 'install', 'run', 'dlx', 'add', 'remove', 'update', 'why', 'list', 'audit',
    'publish', 'pack', 'prune', 'store', 'fetch', 'env', 'config', 'init', 'import', 'link',
    'root', 'bin', 'doctor', 'licenses', 'outdated', 'patch', 'server',
  ]);
  for (const [name, command] of Object.entries(scripts)) {
    for (const match of command.matchAll(/pnpm\s+([a-z0-9][a-z0-9:_-]*)/g)) {
      const referenced = match[1];
      if (builtins.has(referenced)) {
        continue;
      }
      assert.ok(scripts[referenced], `${name} references missing script ${referenced}`);
    }
  }
});

test('shared commands and legacy aliases are preserved', () => {
  const requiredScripts = [
    'check:ci',
    'check:frontend',
    'check:visual',
    'check:browser',
    'check:server',
    'check:migrations',
    'check:desktop',
    'check:ios',
    'check:hygiene',
    'check:english',
    'check:whitespace',
    'check:rust',
    'check:rust:fmt',
    'check:rust:clippy',
    'check:rust:deps',
    'check:rust:test',
    'check:rust:test:core',
    'check:rust:test:desktop',
    'test:scripts',
    'test:ci-scripts',
    'privacy:check',
    'maintainability:check',
    'lint:suppressions:check',
    'select:checks',
  ];
  for (const name of requiredScripts) {
    assert.ok(scripts[name], `missing package.json script ${name}`);
  }
  assert.match(scripts['check:ci'], /select-checks\.mjs/);
  assert.match(scripts['select:checks'], /select-checks\.mjs/);
});

test('platform-bound groups use macOS runners and portable groups use Linux', () => {
  const groups = new Map(loadInventory().groups.map((group) => [group.id, group]));
  for (const id of ['visual', 'browser', 'desktop', 'ios']) {
    assert.ok(/^(macos|xcode)-/.test(groups.get(id).runner), id);
  }
  for (const id of ['frontend', 'server', 'migrations', 'hygiene']) {
    assert.equal(groups.get(id).runner, 'ubuntu-latest', id);
  }
  assert.equal(groups.get('hygiene').always, true);
});

test('check:ios compiles the shared Kordi Beta scheme unsigned for the simulator', () => {
  const scheme = path.join(repoRoot, 'app/ios/Kordi.xcodeproj/xcshareddata/xcschemes/Kordi Beta.xcscheme');
  assert.ok(existsSync(scheme), 'shared Kordi Beta scheme must exist');
  const command = scripts['check:ios'];
  assert.match(command, /-scheme 'Kordi Beta'/);
  assert.match(command, /-configuration Beta/);
  assert.match(command, /generic\/platform=iOS Simulator/);
  assert.match(command, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(command, /CODE_SIGNING_REQUIRED=NO/);
});

test('hygiene wrapper keeps local defaults and honors the explicit CI comparison', () => {
  const wrapper = path.join(repoRoot, 'scripts/ci/run-hygiene.sh');
  assert.match(scripts['check:hygiene'], /run-hygiene\.sh/);

  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const local = spawnSync('bash', [wrapper, '--print-plan'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, KORDI_CI_BASE: '', KORDI_CI_HEAD: '', KORDI_HYGIENE_BASE: '' },
  });
  assert.equal(local.status, 0, local.stderr);
  assert.ok(local.stdout.includes('node scripts/repository-privacy-guard.mjs\n'));
  assert.ok(!local.stdout.includes('--comparison'));
  assert.ok(local.stdout.includes('bash scripts/check-hygiene.sh\n'));
  assert.ok(local.stdout.includes('node scripts/check-maintainability-ratchet.mjs\n'));
  assert.ok(local.stdout.includes('node scripts/check-eslint-suppressions-ratchet.mjs\n'));
  assert.ok(local.stdout.includes('pnpm test:scripts'));
  assert.ok(local.stdout.includes('pnpm test:ci-scripts'));

  const ci = spawnSync('bash', [wrapper, '--print-plan'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      KORDI_CI_BASE: base,
      KORDI_CI_HEAD: head,
      KORDI_HYGIENE_BASE: base,
    },
  });
  assert.equal(ci.status, 0, ci.stderr);
  assert.ok(ci.stdout.includes(`node scripts/repository-privacy-guard.mjs --comparison ${base}...${head}`));
  assert.ok(ci.stdout.includes(`bash scripts/check-hygiene.sh ${base}...${head}`));
  assert.ok(ci.stdout.includes(`node scripts/check-maintainability-ratchet.mjs ${base}...${head}`));
  assert.ok(ci.stdout.includes(`node scripts/check-eslint-suppressions-ratchet.mjs ${base}...${head}`));

  const hygieneOnly = spawnSync('bash', [wrapper, '--print-plan'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      KORDI_CI_BASE: '',
      KORDI_CI_HEAD: '',
      KORDI_HYGIENE_BASE: base,
    },
  });
  assert.equal(hygieneOnly.status, 0, hygieneOnly.stderr);
  assert.ok(hygieneOnly.stdout.includes(`bash scripts/check-hygiene.sh ${base}...HEAD`));

  const rejected = spawnSync('bash', [wrapper, '--unexpected'], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unknown argument/);
});

test('selection policy exposes the required shared paths', () => {
  assert.deepEqual([...SHARED_PATHS], expectedSharedPaths);
});

test('run-check prints the inventory command for every group with --dry-run', () => {
  for (const group of loadInventory().groups) {
    const result = spawnNode(runCheck, [group.id, '--dry-run']);
    assert.equal(result.status, 0, `${group.id}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), group.command, group.id);
  }
});

test('run-check rejects unknown groups with actionable output', () => {
  const result = spawnNode(runCheck, ['not-a-group']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown check group/);
  assert.match(result.stderr, /frontend/);
  assert.match(result.stderr, /hygiene/);
});

test('run-check reports unavailable platform prerequisites without running', () => {
  const result = spawnNode(runCheck, ['ios'], {
    env: { ...process.env, KORDI_CHECK_PLATFORM: 'linux' },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /unavailable/);
  assert.match(result.stderr, /not reported as passing/);
  assert.equal(result.stdout.trim(), '');
});

test('selection manifests list every group in inventory order', () => {
  const result = spawnNode(selectChecks, ['--all', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.deepEqual(
    manifest.groups.map((group) => group.id),
    requiredGroupIds,
  );
  assert.equal(manifest.generatedBy, 'scripts/ci/select-checks.mjs');
  assert.equal(manifest.version, 1);
});
