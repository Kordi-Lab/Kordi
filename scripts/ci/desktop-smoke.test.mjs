import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(new URL('../../app/desktop/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(path.join(root, '.github/workflows/postmerge-ci.yml'), 'utf8'));
const step = workflow.jobs['build-smoke'].steps.find((entry) => entry.name === 'Build desktop without signing credentials');

function smoke(t, exitCode = 0) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'desktop-smoke-contract-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const observed = path.join(temporary, 'observed.jsonl');
  // Execute the package.json entry and real shell wrapper/packager. Stub only
  // expensive external build commands, capturing their prepared inputs first.
  writeFileSync(path.join(temporary, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--dir') {
  const cwd = path.resolve(args[1]);
  const command = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'))).scripts[args[2]];
  const result = spawnSync('bash', ['-c', command + ' "$@"', 'smoke', ...args.slice(3)], { cwd, env: { ...process.env, SMOKE_SOURCE_PROFILE: process.env.KORDI_DISTRIBUTION_PROFILE }, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const record = { args };
if (args[0] === 'exec') {
  const overlay = args[args.lastIndexOf('--config') + 1];
  record.overlay = overlay;
  record.sourceProfile = process.env.SMOKE_SOURCE_PROFILE;
  record.config = JSON.parse(fs.readFileSync(overlay));
  record.profilePath = process.env.KORDI_DISTRIBUTION_PROFILE;
  record.profile = JSON.parse(fs.readFileSync(record.profilePath));
  record.origin = process.env.VITE_KORDI_CLOUD_API_BASE;
  record.secretNames = Object.keys(process.env).filter(key => /^(APPLE_|TAURI_|CI_SMOKE_)/.test(key));
  for (const icon of record.config.bundle.icon) {
    if (fs.statSync(icon).size < 1000) throw new Error('Smoke icons must be real bundle assets.');
  }
}
fs.appendFileSync(process.env.SMOKE_OBSERVED, JSON.stringify(record) + '\\n');
if (!['release:secret-guard', 'tauri:prepare-sidecars', 'exec'].includes(args[0])) process.exit(99);
process.exit(args[0] === 'exec' ? Number(process.env.SMOKE_EXIT) : 0);
`, { mode: 0o755 });
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH}`,
      SMOKE_OBSERVED: observed, SMOKE_EXIT: String(exitCode),
      KORDI_DISTRIBUTION_PROFILE: '/nonexistent-operator-profile',
      KORDI_EXPECTED_EDITION: 'research', KORDI_EXPECTED_ENVIRONMENT: 'production',
      KORDI_EXPECTED_BACKEND_ORIGIN: 'https://operator.example.test',
      APPLE_TEAM_ID: 'synthetic-must-not-reach-build',
      APPLE_ID: 'synthetic-must-not-reach-build',
      TAURI_SIGNING_PRIVATE_KEY: 'synthetic-must-not-reach-build',
      TAURI_CONFIG: '{"identifier":"test.operator.override"}',
      CI_SMOKE_APPLE_IDENTITY: 'synthetic-must-not-reach-build',
    },
  });
  return { result, records: existsSync(observed) ? readFileSync(observed, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('post-merge smoke reaches the real packager with isolated unsigned inputs', (t) => {
  const { result, records } = smoke(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(records.map((record) => record.args[0]), ['release:secret-guard', 'tauri:prepare-sidecars', 'exec']);
  const build = records.at(-1);
  assert.deepEqual(build.args.slice(0, 3), ['exec', 'tauri', 'build']);
  assert.deepEqual(build.args.slice(-2), ['--bundles', 'app']);
  assert.equal(build.config.bundle.macOS.signingIdentity, '-');
  assert.equal(build.config.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(build.config.plugins.updater, { pubkey: '', endpoints: [] });
  assert.equal(build.config.identifier, 'test.kordi.ci.staging.desktop');
  assert.deepEqual(build.config.plugins['deep-link'].desktop.schemes, ['kordi-ci-staging']);
  assert.equal(build.origin, 'https://desktop-smoke.example.test');
  assert.equal(build.profile.routing.environment, 'staging');
  assert.equal(build.profile.authentication.admission, 'approved-testers');
  assert.deepEqual(build.secretNames, []);
  assert.equal(existsSync(build.overlay), false, 'prepared configuration must be removed');
  assert.equal(existsSync(build.profilePath), false, 'temporary profile must be removed');
  assert.equal(existsSync(build.sourceProfile), false, 'synthetic source profile must be removed');
});

test('post-merge smoke propagates packaging failures and cleans prepared inputs', (t) => {
  const { result, records } = smoke(t, 23);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Packaging command failed/);
  assert.equal(existsSync(records.at(-1).overlay), false);
  assert.equal(existsSync(records.at(-1).profilePath), false);
  assert.equal(existsSync(records.at(-1).sourceProfile), false);
});

test('packaging still rejects arbitrary configuration overrides before any build', () => {
  const result = spawnSync('bash', ['scripts/build-macos-desktop.sh', '--config', '{"bundle":{"createUpdaterArtifacts":false}}', '--bundles', 'app'],
    { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported packaging option/);
});
