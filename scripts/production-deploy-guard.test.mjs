#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIRM_PHRASE,
  DEFAULT_STACK,
  HOST_WIDE_LOCK,
  PRODUCTION_ENVIRONMENT,
  artifactDigestOf,
  buildDeploymentPlan,
  formatPlanSummary,
  parseArguments,
  renderPlan,
  runCli,
  validateArtifactDigest,
  validateBackupId,
  validateDeploymentInputs,
  validateSha,
} from './production-deploy-guard.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const IMAGE = `registry.example/kordi-cloud-server@${DIGEST}`;

function validInputs(overrides = {}) {
  return {
    sha: SHA,
    artifact: DIGEST,
    backup: 'backup-2026-09-19T00-00-00Z',
    rollbackPlan: 'Deploy the previous revision if the schema still supports it.',
    schemaCompatibility: 'Additive migration; the previous binary remains compatible.',
    actor: 'operator-one',
    workflow: 'https://github.com/acme/kordi/actions/runs/1',
    ...overrides,
  };
}

function captureStream() {
  let text = '';
  return {
    stream: { write(chunk) { text += chunk; } },
    read() { return text; },
  };
}

function withTempDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kordi-guard-test-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('validateSha requires a full lowercase SHA', () => {
  assert.equal(validateSha(SHA).ok, true);
  for (const value of ['', SHA.slice(0, 12), SHA.toUpperCase(), 'z'.repeat(40), undefined]) {
    assert.equal(validateSha(value).ok, false, `expected ${String(value)} to be rejected`);
  }
});

test('artifact validation accepts only immutable sha256 digests', () => {
  assert.equal(validateArtifactDigest(DIGEST).ok, true);
  assert.equal(validateArtifactDigest(IMAGE).ok, true);
  assert.equal(artifactDigestOf(DIGEST), DIGEST);
  assert.equal(artifactDigestOf(IMAGE), DIGEST);
  for (const value of [
    '',
    'kordi-cloud-server:latest',
    'kordi-cloud-server:prod-1',
    'registry.example/kordi-cloud-server:stable',
    `sha256:${'ab'.repeat(31)}`,
    `sha256:${'AB'.repeat(32)}`,
    `registry.example/kordi-cloud-server@sha256:${'ab'.repeat(31)}`,
    `registry.example/kordi-cloud-server@sha384:${'ab'.repeat(48)}`,
  ]) {
    assert.equal(validateArtifactDigest(value).ok, false, `expected ${value} to be rejected`);
    assert.equal(artifactDigestOf(value), null);
  }
});

test('backup identifiers reject empty and whitespace-bearing values', () => {
  assert.equal(validateBackupId('snapshot-123').ok, true);
  assert.equal(validateBackupId('projects/example/snapshots/backup-1').ok, true);
  for (const value of ['', ' ', 'backup 1', 'backup\n1', undefined]) {
    assert.equal(validateBackupId(value).ok, false, `expected ${String(value)} to be rejected`);
  }
});

test('missing or malformed inputs fail closed with per-field errors', () => {
  const validation = validateDeploymentInputs({});
  assert.equal(validation.ok, false);
  const joined = validation.errors.join('\n');
  for (const field of ['sha', 'artifact', 'backup', 'rollbackPlan', 'schemaCompatibility']) {
    assert.match(joined, new RegExp(`^${field}:`, 'm'));
  }
  assert.throws(() => buildDeploymentPlan({}), /invalid production deployment inputs/);
});

test('blank statements and wrong confirm phrases are rejected', () => {
  assert.equal(
    validateDeploymentInputs(validInputs({ rollbackPlan: '   ' })).ok,
    false,
  );
  assert.equal(
    validateDeploymentInputs(validInputs({ schemaCompatibility: '' })).ok,
    false,
  );
  assert.equal(
    validateDeploymentInputs(validInputs({ confirm: 'yes' })).ok,
    false,
  );
  assert.equal(
    validateDeploymentInputs(validInputs({ confirm: CONFIRM_PHRASE })).ok,
    true,
  );
});

test('builds a deterministic plan with stable steps and key order', () => {
  const plan = buildDeploymentPlan(validInputs({ confirm: CONFIRM_PHRASE }));
  assert.deepEqual(Object.keys(plan), [
    'schemaVersion',
    'environment',
    'stack',
    'sha',
    'artifact',
    'artifactDigest',
    'backup',
    'rollbackPlan',
    'schemaCompatibility',
    'actor',
    'workflow',
    'confirmed',
    'generatedBy',
    'steps',
  ]);
  assert.equal(plan.environment, PRODUCTION_ENVIRONMENT);
  assert.equal(plan.stack, DEFAULT_STACK);
  assert.equal(plan.artifactDigest, DIGEST);
  assert.equal(plan.confirmed, true);
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    [
      'acquire-lock',
      'verify-revision',
      'prepare-deployment',
      'verify-artifact-presence',
      'sync-and-build',
      'deploy-artifact',
      'verify-artifact',
      'verify-rollout',
      'verify-health',
      'verify-smoke',
      'record-deployment',
      'release-lock',
    ],
  );
  assert.equal(plan.steps[0].lock, HOST_WIDE_LOCK);
  assert.equal(plan.steps.at(-1).lock, HOST_WIDE_LOCK);
  assert.equal(renderPlan(plan), renderPlan(buildDeploymentPlan(validInputs({ confirm: CONFIRM_PHRASE }))));
  assert.match(formatPlanSummary(plan), /Production deployment plan/);
});

test('parseArguments supports repeatable flags and inline values', () => {
  const options = parseArguments([
    '--sha', SHA,
    '--artifact', IMAGE,
    '--backup=snapshot-1',
    '--rollback-plan', 'roll back the binary',
    '--schema-compatibility', 'compatible',
    '--json',
  ]);
  assert.equal(options.sha, SHA);
  assert.equal(options.artifact, IMAGE);
  assert.equal(options.backup, 'snapshot-1');
  assert.equal(options.rollbackPlan, 'roll back the binary');
  assert.equal(options.schemaCompatibility, 'compatible');
  assert.equal(options.json, true);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
  assert.throws(() => parseArguments(['--sha']), /requires a value/);
});

test('runCli writes a deterministic plan and rejects invalid input', () => {
  withTempDirectory((directory) => {
    const out = path.join(directory, 'plan.json');
    const stdout = captureStream();
    const stderr = captureStream();
    const code = runCli(
      [
        '--sha', SHA,
        '--artifact', IMAGE,
        '--backup', 'snapshot-1',
        '--rollback-plan', 'roll back the binary',
        '--schema-compatibility', 'compatible',
        '--out', out,
      ],
      { stdout: stdout.stream, stderr: stderr.stream, cwd: directory },
    );
    assert.equal(code, 0, stderr.read());
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.sha, SHA);
    assert.equal(plan.artifactDigest, DIGEST);

    const failure = captureStream();
    const invalidCode = runCli(['--sha', SHA], { stdout: captureStream().stream, stderr: failure.stream });
    assert.equal(invalidCode, 1);
    assert.match(failure.read(), /invalid production deployment inputs/);
  });
});
