import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_GROUP_IDS,
  buildGroupResults,
  createFullManifest,
  evaluateGate,
  formatGateReport,
  mapJobResult,
  parseManifestText,
  validateManifest,
} from './check-ci-results.mjs';

const scriptPath = fileURLToPath(new URL('./check-ci-results.mjs', import.meta.url));
const EXPECTED_REVISION = 'a'.repeat(40);
const BASE_REVISION = 'b'.repeat(40);
const STALE_REVISION = 'c'.repeat(40);

function fixtureManifest(overrides = {}) {
  return {
    version: 1,
    base: BASE_REVISION,
    head: EXPECTED_REVISION,
    mode: 'changed',
    fallback: false,
    generatedBy: 'scripts/ci/select-checks.mjs',
    groups: REQUIRED_GROUP_IDS.map((id) => ({ id, applicable: true, reason: `${id} inputs changed` })),
    ...overrides,
  };
}

function fixtureResult(group, overrides = {}) {
  return {
    group,
    applicable: true,
    executed: true,
    outcome: 'success',
    sha: EXPECTED_REVISION,
    runId: '17000000000',
    ...overrides,
  };
}

function fixtureResults() {
  return REQUIRED_GROUP_IDS.map((id) => fixtureResult(id));
}

function gate(manifest = fixtureManifest(), results = fixtureResults()) {
  return evaluateGate({ manifest, results, expectedRevision: EXPECTED_REVISION });
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'kordi-ci-gate-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('success fixture passes every applicable group', () => {
  const report = gate();

  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.groups.length, REQUIRED_GROUP_IDS.length);
  assert.ok(report.groups.every((group) => group.status === 'passed'));
});

test('real failure fixture fails the gate with a failed outcome', () => {
  const results = fixtureResults().map((result) => (
    result.group === 'server' ? { ...result, outcome: 'failure' } : result
  ));
  const report = gate(fixtureManifest(), results);

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.group === 'server' && failure.code === 'failed'));
});

test('timeout fixture fails the gate for both timeout spellings', () => {
  for (const outcome of ['timeout', 'timed_out']) {
    const results = fixtureResults().map((result) => (
      result.group === 'migrations' ? { ...result, outcome } : result
    ));
    const report = gate(fixtureManifest(), results);

    assert.equal(report.passed, false, outcome);
    assert.ok(
      report.failures.some((failure) => failure.group === 'migrations' && failure.code === 'timed-out'),
      outcome,
    );
  }
});

test('cancellation fixture fails the gate', () => {
  const results = fixtureResults().map((result) => (
    result.group === 'visual' ? { ...result, outcome: 'cancelled' } : result
  ));
  const report = gate(fixtureManifest(), results);

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.group === 'visual' && failure.code === 'cancelled'));
});

test('unexpected skip fixture fails the gate even though no job failed', () => {
  const results = fixtureResults().map((result) => (
    result.group === 'desktop' ? { ...result, executed: false, outcome: 'skipped' } : result
  ));
  const report = gate(fixtureManifest(), results);

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.group === 'desktop' && failure.code === 'unexpected-skip'));
});

test('legitimate not-applicable fixture passes with a visible reason', () => {
  const manifest = fixtureManifest({
    groups: fixtureManifest().groups.map((group) => (
      group.id === 'ios'
        ? { id: group.id, applicable: false, reason: 'no iOS sources, configuration, or shared dependencies changed' }
        : group
    )),
  });
  const results = fixtureResults().map((result) => (
    result.group === 'ios' ? { ...result, applicable: false, executed: false, outcome: 'not_applicable' } : result
  ));
  const report = gate(manifest, results);

  assert.equal(report.passed, true);
  const entry = report.groups.find((group) => group.id === 'ios');
  assert.equal(entry.status, 'not-applicable');
  assert.match(formatGateReport(report), /ios: not applicable - no iOS sources/);
});

test('missing outputs fail the gate and an empty green wrapper cannot pass', () => {
  const withoutServer = fixtureResults().filter((result) => result.group !== 'server');
  const missing = gate(fixtureManifest(), withoutServer);

  assert.equal(missing.passed, false);
  assert.ok(missing.failures.some((failure) => failure.group === 'server' && failure.code === 'missing-result'));

  const empty = gate(fixtureManifest(), []);
  assert.equal(empty.passed, false);
  assert.equal(
    empty.failures.filter((failure) => failure.code === 'missing-result').length,
    REQUIRED_GROUP_IDS.length,
  );
});

test('stale revision outputs fail the gate', () => {
  const results = fixtureResults().map((result) => (
    result.group === 'hygiene' ? { ...result, sha: STALE_REVISION } : result
  ));
  const report = gate(fixtureManifest(), results);

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.group === 'hygiene' && failure.code === 'stale-revision'));
});

test('invalid manifests fail closed', () => {
  const cases = [
    ['wrong version', fixtureManifest({ version: 2 })],
    ['wrong head', fixtureManifest({ head: STALE_REVISION })],
    ['missing required group', fixtureManifest({
      groups: fixtureManifest().groups.filter((group) => group.id !== 'ios'),
    })],
    ['not applicable without a reason', fixtureManifest({
      groups: fixtureManifest().groups.map((group) => (
        group.id === 'ios' ? { id: group.id, applicable: false, reason: '' } : group
      )),
    })],
    ['duplicate group', fixtureManifest({
      groups: [...fixtureManifest().groups, { id: 'frontend', applicable: true, reason: 'duplicate' }],
    })],
    ['missing fallback flag', (() => {
      const manifest = fixtureManifest();
      delete manifest.fallback;
      return manifest;
    })()],
    ['not an object', null],
  ];

  for (const [label, manifest] of cases) {
    const report = evaluateGate({ manifest, results: fixtureResults(), expectedRevision: EXPECTED_REVISION });
    assert.equal(report.passed, false, label);
    assert.ok(report.failures.some((failure) => failure.code === 'invalid-manifest'), label);
  }
});

test('malformed manifest JSON is reported without throwing', () => {
  const parsed = parseManifestText('{"version": 1,');

  assert.equal(parsed.manifest, undefined);
  assert.match(parsed.errors[0], /not valid JSON/);

  const report = evaluateGate({
    manifest: parsed.manifest,
    manifestErrors: parsed.errors,
    results: fixtureResults(),
    expectedRevision: EXPECTED_REVISION,
  });
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.code === 'invalid-manifest'));
});

test('detector failure without a manifest fails the gate', () => {
  const report = evaluateGate({
    manifest: undefined,
    manifestErrors: ['manifest is not valid JSON: unexpected end of input'],
    results: [],
    expectedRevision: EXPECTED_REVISION,
  });

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.code === 'invalid-manifest'));
});

test('fallback manifest is valid, visible, and still requires every result', () => {
  const manifest = createFullManifest({
    base: BASE_REVISION,
    head: EXPECTED_REVISION,
    reason: 'change detection failed',
  });

  assert.deepEqual(validateManifest(manifest, { expectedRevision: EXPECTED_REVISION }), []);
  assert.equal(manifest.fallback, true);

  const passing = gate(manifest, REQUIRED_GROUP_IDS.map((id) => fixtureResult(id)));
  assert.equal(passing.passed, true);
  assert.ok(passing.warnings.some((warning) => warning.code === 'fallback-coverage'));

  const failing = gate(manifest, []);
  assert.equal(failing.passed, false);
});

test('createFullManifest refuses to drop required groups', () => {
  assert.throws(
    () => createFullManifest({ head: EXPECTED_REVISION, groupIds: ['frontend'] }),
    /missing required groups/,
  );
});

test('emit maps GitHub job results to completion outcomes', () => {
  assert.deepEqual(mapJobResult('success', true), { executed: true, outcome: 'success' });
  assert.deepEqual(mapJobResult('failure', true), { executed: true, outcome: 'failure' });
  assert.deepEqual(mapJobResult('cancelled', true), { executed: true, outcome: 'cancelled' });
  assert.deepEqual(mapJobResult('timed_out', true), { executed: true, outcome: 'timeout' });
  assert.deepEqual(mapJobResult('skipped', true), { executed: false, outcome: 'skipped' });
  assert.deepEqual(mapJobResult('skipped', false), { executed: false, outcome: 'not_applicable' });
  assert.deepEqual(mapJobResult('', true), { executed: false, outcome: 'missing' });
});

test('buildGroupResults keeps the completion schema and refuses unknown groups', () => {
  const manifest = fixtureManifest({
    groups: fixtureManifest().groups.map((group) => (
      group.id === 'ios' ? { id: group.id, applicable: false, reason: 'no iOS changes' } : group
    )),
  });
  const results = buildGroupResults({
    manifest,
    jobResults: [
      { group: 'frontend', jobResult: 'success' },
      { group: 'ios', jobResult: 'skipped' },
    ],
    sha: EXPECTED_REVISION,
    runId: 42,
  });

  assert.deepEqual(results, [
    { group: 'frontend', applicable: true, executed: true, outcome: 'success', sha: EXPECTED_REVISION, runId: '42' },
    { group: 'ios', applicable: false, executed: false, outcome: 'not_applicable', sha: EXPECTED_REVISION, runId: '42' },
  ]);
  assert.throws(
    () => buildGroupResults({
      manifest,
      jobResults: [{ group: 'unknown', jobResult: 'success' }],
      sha: EXPECTED_REVISION,
      runId: 1,
    }),
    /does not contain group/,
  );
});

test('completion applicability must match the manifest', () => {
  const manifest = fixtureManifest({
    groups: fixtureManifest().groups.map((group) => (
      group.id === 'ios' ? { id: group.id, applicable: false, reason: 'no iOS changes' } : group
    )),
  });
  const results = fixtureResults().map((result) => (
    result.group === 'ios'
      ? { ...result, applicable: true, executed: false, outcome: 'skipped' }
      : result
  ));
  const report = gate(manifest, results);

  assert.equal(report.passed, false);
  assert.ok(
    report.failures.some((failure) => failure.group === 'ios' && failure.code === 'inconsistent-applicability'),
  );
});

test('duplicate, malformed, and unexpected results are handled explicitly', () => {
  const duplicated = gate(fixtureManifest(), [...fixtureResults(), fixtureResult('frontend')]);
  assert.equal(duplicated.passed, false);
  assert.ok(duplicated.failures.some((failure) => failure.code === 'duplicate-result'));

  const malformed = gate(fixtureManifest(), [
    ...fixtureResults().filter((result) => result.group !== 'server'),
    { group: 'server', applicable: true, executed: true, outcome: 'success' },
  ]);
  assert.equal(malformed.passed, false);
  assert.ok(malformed.failures.some((failure) => failure.group === 'server' && failure.code === 'malformed-result'));

  const unexpected = gate(fixtureManifest(), [...fixtureResults(), fixtureResult('extra')]);
  assert.equal(unexpected.passed, true);
  assert.ok(unexpected.warnings.some((warning) => warning.code === 'unexpected-result'));
});

test('success without executed evidence is not a valid result', () => {
  const results = fixtureResults().map((result) => (
    result.group === 'browser' ? { ...result, executed: false } : result
  ));
  const report = gate(fixtureManifest(), results);

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.group === 'browser' && failure.code === 'invalid-result'));
});

test('CLI evaluate exits non-zero for a failing gate and zero for a passing gate', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    await writeFile(manifestPath, JSON.stringify(fixtureManifest()));
    await writeFile(resultsPath, JSON.stringify(fixtureResults()));

    const passing = runCli([
      'evaluate', '--manifest', manifestPath, '--results', resultsPath,
      '--expected-revision', EXPECTED_REVISION,
    ]);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /PASS/);

    await writeFile(resultsPath, JSON.stringify(fixtureResults().map((result) => (
      result.group === 'server' ? { ...result, outcome: 'failure' } : result
    ))));
    const failing = runCli([
      'evaluate', '--manifest', manifestPath, '--results', resultsPath,
      '--expected-revision', EXPECTED_REVISION, '--json',
    ]);
    assert.equal(failing.status, 1, failing.stderr);
    assert.equal(JSON.parse(failing.stdout).passed, false);
  });
});

test('CLI evaluate loads per-group result files from a directory', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.json');
    const resultsDirectory = join(directory, 'results');
    await writeFile(manifestPath, JSON.stringify(fixtureManifest()));
    await mkdir(resultsDirectory);
    await writeFile(
      join(resultsDirectory, 'frontend.json'),
      JSON.stringify(fixtureResult('frontend')),
    );
    await writeFile(
      join(resultsDirectory, 'platforms.json'),
      JSON.stringify(REQUIRED_GROUP_IDS
        .filter((id) => id === 'desktop' || id === 'ios')
        .map((id) => fixtureResult(id))),
    );

    const report = runCli([
      'evaluate', '--manifest', manifestPath, '--results-dir', resultsDirectory,
      '--expected-revision', EXPECTED_REVISION,
    ]);
    assert.equal(report.status, 1, report.stderr);
    assert.match(report.stdout, /missing-result/);
  });
});

test('CLI full-manifest writes a manifest that check-manifest accepts', async () => {
  await withTemporaryDirectory(async (directory) => {
    const out = join(directory, 'manifest.json');
    const generated = runCli([
      'full-manifest', '--base', BASE_REVISION, '--head', EXPECTED_REVISION,
      '--mode', 'fallback', '--out', out,
    ]);
    assert.equal(generated.status, 0, generated.stderr);

    const checked = runCli(['check-manifest', '--manifest', out, '--expected-revision', EXPECTED_REVISION]);
    assert.equal(checked.status, 0, checked.stderr);

    const stale = runCli(['check-manifest', '--manifest', out, '--expected-revision', STALE_REVISION]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /does not match expected revision/);
  });
});

test('CLI applicable and emit produce machine-readable output', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    await writeFile(manifestPath, JSON.stringify(fixtureManifest({
      groups: fixtureManifest().groups.map((group) => (
        group.id === 'ios' ? { id: group.id, applicable: false, reason: 'no iOS changes' } : group
      )),
    })));

    const applicable = runCli(['applicable', '--manifest', manifestPath, '--group', 'ios']);
    assert.equal(applicable.status, 0, applicable.stderr);
    assert.equal(applicable.stdout.trim(), 'false');

    const emitted = runCli([
      'emit', '--manifest', manifestPath,
      '--result', 'ios=skipped', '--result', 'frontend=success',
      '--sha', EXPECTED_REVISION, '--run-id', '7', '--out', resultsPath,
    ]);
    assert.equal(emitted.status, 0, emitted.stderr);
    const results = JSON.parse(await readFile(resultsPath, 'utf8'));
    assert.deepEqual(results[0], {
      group: 'ios',
      applicable: false,
      executed: false,
      outcome: 'not_applicable',
      sha: EXPECTED_REVISION,
      runId: '7',
    });
  });
});

test('CLI emit fails with fail-on-invalid but still writes the completion result', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    await writeFile(manifestPath, JSON.stringify(fixtureManifest()));

    const emitted = runCli([
      'emit', '--manifest', manifestPath,
      '--result', 'server=failure',
      '--sha', EXPECTED_REVISION, '--run-id', '7',
      '--fail-on-invalid', '--out', resultsPath,
    ]);
    assert.equal(emitted.status, 1);
    assert.match(emitted.stderr, /server: failure/);
    const results = JSON.parse(await readFile(resultsPath, 'utf8'));
    assert.equal(results[0].outcome, 'failure');
    assert.equal(results[0].executed, true);
  });
});

test('CLI emit rejects a manifest for another revision', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(fixtureManifest({ head: STALE_REVISION })));

    const emitted = runCli([
      'emit', '--manifest', manifestPath, '--result', 'frontend=success',
      '--sha', EXPECTED_REVISION, '--run-id', '7',
    ]);
    assert.equal(emitted.status, 1);
    assert.match(emitted.stderr, /does not match expected revision/);
  });
});
