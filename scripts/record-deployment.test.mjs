#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRecord,
  defaultRecordPath,
  formatRecordTimestamp,
  formatRecordSummary,
  parseArguments,
  recordFilename,
  redactText,
  renderRecord,
  resolveRecordPath,
  resolveVerificationInput,
  runCli,
  validateActor,
  validateArtifactDigest,
  validateDeploymentOptions,
  validateEnvironment,
  validateSha,
  validateStackId,
  validateWorkflowUrl,
  writeRecordFile,
} from './record-deployment.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ARTIFACT = `sha256:${'ab'.repeat(32)}`;
const NOW = new Date('2026-09-19T11:30:00.000Z');

function validOptions(overrides = {}) {
  return {
    environment: 'dev',
    stack: 'issue-1592',
    sha: SHA,
    actor: 'operator-one',
    artifact: ARTIFACT,
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
  const directory = mkdtempSync(path.join(tmpdir(), 'kordi-record-test-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('builds a deterministic record with stable key order', () => {
  const record = buildRecord(validOptions(), NOW);
  assert.deepEqual(Object.keys(record), [
    'schemaVersion',
    'environment',
    'stack',
    'revision',
    'actor',
    'artifact',
    'backup',
    'verification',
    'rollback',
    'workflow',
    'recordedAt',
  ]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.recordedAt, '2026-09-19T11:30:00.000Z');
  assert.equal(record.backup, null);
  assert.equal(renderRecord(record), renderRecord(buildRecord(validOptions(), NOW)));
  assert.ok(renderRecord(record).endsWith('\n'));
});

test('rejects missing required fields', () => {
  const validation = validateDeploymentOptions({});
  assert.equal(validation.ok, false);
  const joined = validation.errors.join('\n');
  for (const field of ['environment', 'stack', 'sha', 'actor', 'artifact']) {
    assert.match(joined, new RegExp(`^${field}:`, 'm'));
  }
});

test('rejects malformed commit SHAs', () => {
  assert.equal(validateSha(SHA).ok, true);
  for (const value of ['', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}0`, 'z'.repeat(40)]) {
    assert.equal(validateSha(value).ok, false, `expected ${value} to be rejected`);
  }
  assert.match(validateSha('abc').error, /40-character/);
});

test('rejects unsupported environments', () => {
  assert.equal(validateEnvironment('dev').ok, true);
  assert.equal(validateEnvironment('production').ok, true);
  assert.equal(validateEnvironment('staging').ok, false);
  assert.equal(validateEnvironment('DEV').ok, false);
  assert.match(validateEnvironment('staging').error, /dev, production/);
});

test('rejects unsafe stack identifiers', () => {
  assert.equal(validateStackId('issue-1592').ok, true);
  assert.equal(validateStackId('dev_2').ok, true);
  for (const value of ['Issue-1592', '../escape', '-leading', '', 'with space', 'a/b']) {
    assert.equal(validateStackId(value).ok, false, `expected ${value} to be rejected`);
  }
});

test('validates actors, artifacts, and workflow URLs', () => {
  assert.equal(validateActor('operator-one').ok, true);
  assert.equal(validateActor('github-actions[bot]').ok, true);
  assert.equal(validateActor('two words').ok, false);
  assert.equal(validateActor('').ok, false);

  assert.equal(validateArtifactDigest(ARTIFACT).ok, true);
  assert.equal(validateArtifactDigest('ab'.repeat(32)).ok, true);
  assert.equal(validateArtifactDigest(`registry.test/app@sha256:${'cd'.repeat(32)}`).ok, true);
  assert.equal(validateArtifactDigest('sha256:short').ok, false);
  assert.equal(validateArtifactDigest('latest').ok, false);
  assert.equal(validateArtifactDigest('sha256:not-hex'.padEnd(71, '0')).ok, false);
  assert.equal(validateArtifactDigest('').ok, false);

  assert.equal(validateWorkflowUrl('https://github.test/actions/runs/1').ok, true);
  assert.equal(validateWorkflowUrl('http://github.test/actions/runs/1').ok, false);
  assert.equal(validateWorkflowUrl('file:///tmp/run').ok, false);
});

test('redacts obvious credential patterns in free-text fields', () => {
  const githubToken = `ghp_${'A'.repeat(36)}`;
  const awsKey = `AKIA${'B'.repeat(16)}`;
  const privateKeyHeader = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ');
  const privateKeyFooter = ['-----END', 'RSA', 'PRIVATE KEY-----'].join(' ');
  const credentialUrl = ['postgres', '://', 'operator', ':', 'hunter2', '@db.test/app'].join('');
  const redacted = redactText([
    `token=${githubToken}`,
    `key ${awsKey}`,
    'Authorization: Bearer abcdefghijklmnop',
    credentialUrl,
    privateKeyHeader,
    'MIIEowIBAAKCAQEA',
    privateKeyFooter,
  ].join('\n'));
  assert.doesNotMatch(redacted, /ghp_/);
  assert.doesNotMatch(redacted, /AKIAB/);
  assert.equal(redacted.includes('hunter2'), false);
  assert.equal(redacted.includes('abcdefghijklmnop'), false);
  assert.equal(redacted.includes(privateKeyHeader), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED PRIVATE KEY\]/);

  const record = buildRecord(validOptions({
    verification: `smoke ok token=${githubToken}`,
    rollback: `password=hunter2 restored`,
    backup: ['postgres', '://', 'user', ':', 'secret', '@db.test/backup'].join(''),
  }), NOW);
  const rendered = renderRecord(record);
  assert.doesNotMatch(rendered, /ghp_/);
  assert.equal(rendered.includes('hunter2'), false);
  assert.equal(rendered.includes('user:secret@'), false);
});

test('resolves a verification file when the value names an existing file', () => {
  withTempDirectory((directory) => {
    const summaryFile = path.join(directory, 'verification.txt');
    fs.writeFileSync(summaryFile, '  rollout healthy; smoke passed  \n');
    assert.equal(
      resolveVerificationInput(summaryFile, { cwd: directory }),
      'rollout healthy; smoke passed',
    );
    assert.equal(resolveVerificationInput('inline summary', { cwd: directory }), 'inline summary');
    assert.equal(resolveVerificationInput(undefined), null);

    const emptyFile = path.join(directory, 'empty.txt');
    fs.writeFileSync(emptyFile, '   \n');
    assert.throws(() => resolveVerificationInput(emptyFile, { cwd: directory }), /empty/);
  });
});

test('protects existing records unless force is passed', () => {
  withTempDirectory((directory) => {
    const recordPath = path.join(directory, 'nested', 'record.json');
    writeRecordFile(recordPath, '{}\n');
    assert.throws(() => writeRecordFile(recordPath, '{}\n'), /already exists/);
    writeRecordFile(recordPath, '{"replaced":true}\n', { force: true });
    assert.equal(fs.readFileSync(recordPath, 'utf8'), '{"replaced":true}\n');
  });
});

test('formats record paths and timestamps deterministically', () => {
  assert.equal(formatRecordTimestamp(NOW), '20260919T113000Z');
  const record = buildRecord(validOptions(), NOW);
  assert.equal(recordFilename(record), `20260919T113000Z-${SHA.slice(0, 12)}.json`);
  assert.equal(
    defaultRecordPath(record, '/repo'),
    `/repo/deploy/deployment-records/dev/20260919T113000Z-${SHA.slice(0, 12)}.json`,
  );
  withTempDirectory((directory) => {
    assert.equal(
      resolveRecordPath(record, { root: '/repo', out: path.join(directory, 'custom.json') }),
      path.join(directory, 'custom.json'),
    );
    assert.equal(
      resolveRecordPath(record, { root: '/repo', out: directory }),
      path.join(directory, recordFilename(record)),
    );
  });
});

test('parseArguments rejects unknown flags and missing values', () => {
  const options = parseArguments([
    '--environment', 'dev', '--stack', 'dev-1', '--sha', SHA, '--actor', 'operator-one',
    '--artifact', ARTIFACT, '--dry-run', '--force',
  ]);
  assert.equal(options.environment, 'dev');
  assert.equal(options.dryRun, true);
  assert.equal(options.force, true);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
  assert.throws(() => parseArguments(['--sha']), /requires a value/);
  assert.throws(() => parseArguments(['--sha', '--actor', 'x']), /requires a value/);
});

test('dry run validates and prints without writing a record', () => {
  withTempDirectory((directory) => {
    const target = path.join(directory, 'records', 'record.json');
    const stdout = captureStream();
    const stderr = captureStream();
    const status = runCli([
      '--environment', 'production',
      '--stack', 'production-main',
      '--sha', SHA,
      '--actor', 'operator-one',
      '--artifact', ARTIFACT,
      '--verification', 'rollout healthy',
      '--dry-run',
      '--out', target,
    ], { cwd: directory, stdout: stdout.stream, stderr: stderr.stream, now: NOW });
    assert.equal(status, 0, stderr.read());
    assert.equal(fs.existsSync(target), false);
    assert.match(stdout.read(), /dry run: no file written/);
    assert.match(stdout.read(), /"verification": "rollout healthy"/);
    assert.match(stdout.read(), /"recordedAt": "2026-09-19T11:30:00.000Z"/);
  });
});

test('CLI writes the record, reports the path, and refuses to overwrite', () => {
  withTempDirectory((directory) => {
    const target = path.join(directory, 'out', 'record.json');
    const argv = [
      '--environment', 'dev',
      '--stack', 'issue-1592',
      '--sha', SHA,
      '--actor', 'operator-one',
      '--artifact', ARTIFACT,
      '--backup', 'backup-2026-09-19',
      '--rollback', 'application rollback not exercised',
      '--workflow', 'https://github.test/actions/runs/42',
      '--out', target,
    ];
    const stdout = captureStream();
    const stderr = captureStream();
    assert.equal(
      runCli(argv, { cwd: directory, stdout: stdout.stream, stderr: stderr.stream, now: NOW }),
      0,
      stderr.read(),
    );
    assert.equal(stdout.read().includes(`Deployment record: ${target}`), true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).backup, 'backup-2026-09-19');

    const secondStderr = captureStream();
    assert.equal(
      runCli(argv, { cwd: directory, stdout: captureStream().stream, stderr: secondStderr.stream, now: NOW }),
      1,
    );
    assert.match(secondStderr.read(), /already exists/);

    const forcedStderr = captureStream();
    assert.equal(
      runCli([...argv, '--force'], {
        cwd: directory,
        stdout: captureStream().stream,
        stderr: forcedStderr.stream,
        now: NOW,
      }),
      0,
      forcedStderr.read(),
    );
  });
});

test('CLI fails with an actionable message for invalid input', () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const status = runCli([
    '--environment', 'staging',
    '--stack', '../escape',
    '--sha', 'deadbeef',
    '--actor', 'operator one',
    '--artifact', 'latest',
  ], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(status, 1);
  const errors = stderr.read();
  assert.match(errors, /invalid input/);
  assert.match(errors, /environment:/);
  assert.match(errors, /stack:/);
  assert.match(errors, /sha:/);
  assert.match(errors, /actor:/);
  assert.match(errors, /artifact:/);
  assert.equal(stdout.read(), '');
});

test('CLI reads a verification file and prints a human summary', () => {
  withTempDirectory((directory) => {
    const summaryFile = path.join(directory, 'verification.txt');
    fs.writeFileSync(summaryFile, 'health checks passed\n');
    const target = path.join(directory, 'record.json');
    const stdout = captureStream();
    const status = runCli([
      '--environment', 'dev',
      '--stack', 'dev-2',
      '--sha', SHA,
      '--actor', 'operator-one',
      '--artifact', ARTIFACT,
      '--verification', summaryFile,
      '--out', target,
    ], { cwd: directory, stdout: stdout.stream, stderr: captureStream().stream, now: NOW });
    assert.equal(status, 0);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).verification, 'health checks passed');
    assert.match(stdout.read(), /stack: {8}dev-2/);
    assert.match(stdout.read(), /verification: health checks passed/);
  });
});

test('formatRecordSummary reports absent optional fields explicitly', () => {
  const record = buildRecord(validOptions(), NOW);
  const summary = formatRecordSummary(record, '/tmp/record.json');
  assert.match(summary, /backup: {7}not recorded/);
  assert.match(summary, /rollback: {5}not recorded/);
  assert.match(summary, /workflow: {5}not recorded/);
});

test('failed attempts can record an absent artifact without inventing a digest', () => {
  const options = { ...validOptions(), failed: true, artifact: '' };
  assert.equal(validateDeploymentOptions(options).ok, true);
  assert.equal(validateDeploymentOptions({ ...options, failed: false }).ok, false);
  assert.equal(buildRecord(options, NOW).outcome, 'failure');
});
