#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  DEFAULT_REQUIRED_CHECKS,
  DEFAULT_TRUSTED_WORKFLOWS,
  buildWorkflowPathIndex,
  evaluateReadiness,
  formatReadinessReport,
  normalizeCheckRuns,
  parseArguments,
  runCli,
  validateSha,
  workflowRunIdFromDetailsUrl,
} from './check-sha-readiness.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = 'acme/kordi';
const BLOCKING = '.github/workflows/blocking-ci.yml';
const POSTMERGE = '.github/workflows/postmerge-ci.yml';

function checkRun(overrides = {}) {
  return {
    id: 101,
    name: 'CI required',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://github.com/acme/kordi/actions/runs/9001/job/5001',
    ...overrides,
  };
}

function workflowRun(overrides = {}) {
  return { id: 9001, path: BLOCKING, head_sha: SHA, ...overrides };
}

function evaluate(checkRuns, options = {}) {
  return evaluateReadiness({
    sha: SHA,
    checkRuns: normalizeCheckRuns(checkRuns, options.workflowRuns ?? [workflowRun()]),
    requiredChecks: options.requiredChecks,
    trustedWorkflows: options.trustedWorkflows,
  });
}

function captureStream() {
  let text = '';
  return {
    stream: { write(chunk) { text += chunk; } },
    read() { return text; },
  };
}

test('validateSha accepts only full lowercase hexadecimal SHAs', () => {
  assert.equal(validateSha(SHA), true);
  for (const value of [undefined, null, '', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}0`, 'z'.repeat(40)]) {
    assert.equal(validateSha(value), false, `expected ${String(value)} to be rejected`);
  }
});

test('parseArguments collects repeatable checks and workflows', () => {
  const options = parseArguments([
    '--sha', SHA,
    '--check', 'CI required',
    '--check=Post-merge CI required',
    '--workflow', BLOCKING,
    '--repo', REPO,
    '--api-url', 'http://127.0.0.1:9',
    '--json',
  ]);
  assert.equal(options.sha, SHA);
  assert.deepEqual(options.checks, ['CI required', 'Post-merge CI required']);
  assert.deepEqual(options.workflows, [BLOCKING]);
  assert.equal(options.repo, REPO);
  assert.equal(options.apiUrl, 'http://127.0.0.1:9');
  assert.equal(options.json, true);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
  assert.throws(() => parseArguments(['--sha']), /requires a value/);
});

test('workflow run identity is resolved from the job details URL', () => {
  assert.equal(
    workflowRunIdFromDetailsUrl('https://github.com/acme/kordi/actions/runs/12345/job/678'),
    '12345',
  );
  assert.equal(workflowRunIdFromDetailsUrl('https://example.com/not-a-run'), null);
  assert.equal(workflowRunIdFromDetailsUrl(undefined), null);

  const index = buildWorkflowPathIndex([workflowRun({ id: 12345, path: POSTMERGE })]);
  assert.equal(index.get('12345'), POSTMERGE);
  const normalized = normalizeCheckRuns(
    [checkRun({ details_url: 'https://github.com/acme/kordi/actions/runs/12345/job/678' })],
    [workflowRun({ id: 12345, path: POSTMERGE })],
  );
  assert.equal(normalized[0].workflowPath, POSTMERGE);
});

test('passes when the required check succeeded for the exact SHA from a trusted workflow', () => {
  const report = evaluate([checkRun()]);
  assert.equal(report.passed, true);
  assert.equal(report.checks[0].status, 'passed');
  assert.match(report.checks[0].detail, /blocking-ci\.yml/);
  assert.match(formatReadinessReport(report), /PASS/);
});

test('fails when the required check has no run for the SHA', () => {
  const report = evaluate([]);
  assert.equal(report.passed, false);
  assert.equal(report.failures[0].code, 'missing-check');
  assert.match(report.failures[0].detail, /no check run/);
});

test('fails a successful run that reports a different head SHA', () => {
  const report = evaluate([checkRun({ head_sha: OTHER_SHA })]);
  assert.equal(report.passed, false);
  assert.equal(report.failures[0].code, 'wrong-sha');
  assert.match(report.failures[0].detail, /stale or unrelated/);
});

test('rejects skipped, neutral, cancelled, timed-out, and stale conclusions', () => {
  const cases = [
    ['skipped', 'skipped'],
    ['neutral', 'neutral'],
    ['cancelled', 'cancelled'],
    ['timed_out', 'timed-out'],
    ['stale', 'stale'],
    ['failure', 'failure'],
    ['startup_failure', 'startup-failure'],
    ['action_required', 'action-required'],
  ];
  for (const [conclusion, expectedCode] of cases) {
    const report = evaluate([checkRun({ conclusion })]);
    assert.equal(report.passed, false, `expected ${conclusion} to fail`);
    assert.equal(report.failures[0].code, expectedCode);
  }
});

test('fails an incomplete run', () => {
  const report = evaluate([checkRun({ status: 'in_progress', conclusion: null })]);
  assert.equal(report.passed, false);
  assert.equal(report.failures[0].code, 'incomplete');
});

test('rejects a successful run from an untrusted workflow identity', () => {
  const report = evaluate(
    [checkRun({ details_url: 'https://github.com/acme/kordi/actions/runs/7777/job/1' })],
    { workflowRuns: [workflowRun({ id: 7777, path: '.github/workflows/untrusted.yml' })] },
  );
  assert.equal(report.passed, false);
  assert.equal(report.failures[0].code, 'untrusted-workflow');
  assert.match(report.failures[0].detail, /trusted workflows are/);
});

test('rejects a check run with no resolvable workflow identity', () => {
  const report = evaluate([checkRun({ details_url: 'https://example.com/external-check' })]);
  assert.equal(report.passed, false);
  assert.equal(report.failures[0].code, 'untrusted-workflow');
});

test('an older failed run does not shadow a newer trusted success', () => {
  const report = evaluate([
    checkRun({ id: 1, conclusion: 'failure' }),
    checkRun({ id: 2, conclusion: 'success' }),
  ]);
  assert.equal(report.passed, true);
});

test('every required check must pass for the exact SHA', () => {
  const report = evaluate(
    [
      checkRun(),
      checkRun({
        id: 202,
        name: 'Post-merge CI required',
        conclusion: 'cancelled',
        details_url: 'https://github.com/acme/kordi/actions/runs/9002/job/5002',
      }),
    ],
    {
      requiredChecks: ['CI required', 'Post-merge CI required'],
      workflowRuns: [workflowRun(), workflowRun({ id: 9002, path: POSTMERGE })],
    },
  );
  assert.equal(report.passed, false);
  assert.deepEqual(report.failures.map((failure) => failure.code), ['cancelled']);
  assert.equal(report.checks[0].status, 'passed');
  assert.equal(report.checks[1].status, 'failed');
});

test('defaults match the documented check contract', () => {
  assert.deepEqual([...DEFAULT_REQUIRED_CHECKS], ['CI required']);
  assert.deepEqual(
    [...DEFAULT_TRUSTED_WORKFLOWS],
    ['.github/workflows/blocking-ci.yml', '.github/workflows/postmerge-ci.yml'],
  );
});

test('runCli uses an injected fetch implementation', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes('/check-runs')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ total_count: 1, check_runs: [checkRun()] }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ total_count: 1, workflow_runs: [workflowRun()] }),
    };
  };
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli(
    ['--sha', SHA, '--repo', REPO, '--json'],
    { fetchImpl, env: { GH_TOKEN: 'test-token' }, stdout: stdout.stream, stderr: stderr.stream },
  );
  assert.equal(code, 0);
  const report = JSON.parse(stdout.read());
  assert.equal(report.passed, true);
  assert.equal(report.repo, REPO);
  assert.equal(requests.length, 2);
  assert.match(requests[0], new RegExp(`/repos/${REPO}/commits/${SHA}/check-runs`));
  assert.match(requests[1], /\/actions\/runs\?head_sha=/);
});

test('runCli requires a token for the default GitHub API and a valid SHA', async () => {
  const stderr = captureStream();
  const missingToken = await runCli(
    ['--sha', SHA, '--repo', REPO],
    { fetchImpl: async () => { throw new Error('must not fetch'); }, env: {}, stderr: stderr.stream },
  );
  assert.equal(missingToken, 2);
  assert.match(stderr.read(), /GH_TOKEN or GITHUB_TOKEN/);

  const invalidSha = await runCli(
    ['--sha', 'not-a-sha', '--repo', REPO],
    { fetchImpl: async () => { throw new Error('must not fetch'); }, env: {}, stderr: captureStream().stream },
  );
  assert.equal(invalidSha, 2);
});

test('runCli fails closed when the API request fails', async () => {
  const stderr = captureStream();
  const code = await runCli(
    ['--sha', SHA, '--repo', REPO, '--api-url', 'http://127.0.0.1:1'],
    {
      fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) }),
      env: {},
      stderr: stderr.stream,
    },
  );
  assert.equal(code, 1);
  assert.match(stderr.read(), /GitHub API request failed/);
});

test('runCli queries a local fixture server through --api-url', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/check-runs')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: 1, check_runs: [checkRun()] }));
      return;
    }
    if (url.pathname.endsWith('/actions/runs')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: 1, workflow_runs: [workflowRun()] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const code = await runCli(
      [
        '--sha', SHA,
        '--repo', REPO,
        '--api-url', `http://127.0.0.1:${port}`,
        '--check', 'CI required',
        '--workflow', BLOCKING,
      ],
      { env: {}, stdout: stdout.stream, stderr: stderr.stream },
    );
    assert.equal(code, 0, stderr.read());
    assert.match(stdout.read(), /Exact-SHA readiness .* PASS/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
