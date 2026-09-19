#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REQUIRED_CHECKS = Object.freeze(['CI required']);
export const DEFAULT_TRUSTED_WORKFLOWS = Object.freeze([
  '.github/workflows/blocking-ci.yml',
  '.github/workflows/postmerge-ci.yml',
]);
export const DEFAULT_API_URL = 'https://api.github.com';
export const MAX_PAGES = 10;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const RUN_ID_PATTERN = /\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:[/?#]|$)/;

const CONCLUSION_FAILURES = new Map([
  ['failure', { code: 'failure', message: 'failed' }],
  ['timed_out', { code: 'timed-out', message: 'timed out' }],
  ['cancelled', { code: 'cancelled', message: 'was cancelled' }],
  ['skipped', { code: 'skipped', message: 'was skipped, and a skipped run is not evidence of success' }],
  ['neutral', { code: 'neutral', message: 'concluded neutral, which is not success' }],
  ['action_required', { code: 'action-required', message: 'requires manual action before it can be counted' }],
  ['stale', { code: 'stale', message: 'is stale and was superseded by a newer run' }],
  ['startup_failure', { code: 'startup-failure', message: 'failed to start' }],
]);

export const USAGE = `Usage:
  node scripts/check-sha-readiness.mjs --sha <40-hex> \\
    [--check <name>]... [--workflow <path>]... \\
    [--repo <owner/name>] [--api-url <url>] [--json]

Verifies that every required check name has at least one successful check
run for the exact requested SHA from a trusted workflow identity. Default
required check: "CI required". Default trusted workflows:
${DEFAULT_TRUSTED_WORKFLOWS.map((workflow) => `  ${workflow}`).join('\n')}

The GitHub token is read from GH_TOKEN or GITHUB_TOKEN. --api-url supports a
local fixture server; --repo defaults to GITHUB_REPOSITORY.
`;

function shortSha(value) {
  return typeof value === 'string' ? value.slice(0, 12) : '';
}

export function validateSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value);
}

export function workflowRunIdFromDetailsUrl(detailsUrl) {
  if (typeof detailsUrl !== 'string') return null;
  const match = RUN_ID_PATTERN.exec(detailsUrl);
  return match ? match[1] : null;
}

export function buildWorkflowPathIndex(workflowRuns) {
  const index = new Map();
  for (const run of Array.isArray(workflowRuns) ? workflowRuns : []) {
    if (!run || typeof run !== 'object') continue;
    if (run.id === undefined || run.id === null) continue;
    if (typeof run.path !== 'string' || run.path.trim() === '') continue;
    index.set(String(run.id), run);
  }
  return index;
}

export function normalizeCheckRun(raw, workflowPaths = new Map()) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = workflowRunIdFromDetailsUrl(raw.details_url ?? raw.detailsUrl);
  const workflow = runId ? workflowPaths.get(runId) : null;
  const workflowPath = workflow?.path ?? null;
  return {
    id: raw.id ?? null,
    name: typeof raw.name === 'string' ? raw.name : '',
    headSha: typeof raw.head_sha === 'string'
      ? raw.head_sha
      : typeof raw.headSha === 'string'
        ? raw.headSha
        : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    conclusion: typeof raw.conclusion === 'string' ? raw.conclusion : null,
    workflowPath,
    workflow,
    appSlug: raw.app?.slug ?? null,
    detailsUrl: typeof raw.details_url === 'string'
      ? raw.details_url
      : typeof raw.detailsUrl === 'string'
        ? raw.detailsUrl
        : null,
    htmlUrl: typeof raw.html_url === 'string'
      ? raw.html_url
      : typeof raw.htmlUrl === 'string'
        ? raw.htmlUrl
        : null,
  };
}

export function normalizeCheckRuns(rawCheckRuns, workflowRuns = []) {
  const workflowPaths = buildWorkflowPathIndex(workflowRuns);
  const normalized = [];
  for (const raw of Array.isArray(rawCheckRuns) ? rawCheckRuns : []) {
    const run = normalizeCheckRun(raw, workflowPaths);
    if (run) normalized.push(run);
  }
  return normalized;
}

export function evaluateReadiness({
  sha,
  checkRuns = [],
  requiredChecks = DEFAULT_REQUIRED_CHECKS,
  trustedWorkflows = DEFAULT_TRUSTED_WORKFLOWS,
  repo,
  branch = null,
}) {
  const trusted = new Set(trustedWorkflows);
  const report = {
    sha,
    requiredChecks: [...requiredChecks],
    trustedWorkflows: [...trustedWorkflows],
    passed: false,
    checks: [],
    failures: [],
    warnings: [],
  };

  for (const name of requiredChecks) {
    const entry = { name, status: 'failed', detail: null, runs: [], failures: [] };
    report.checks.push(entry);

    const named = checkRuns.filter((run) => run.name === name);
    entry.runs = named.map((run) => ({
      id: run.id,
      workflowPath: run.workflowPath,
      headSha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.detailsUrl,
      htmlUrl: run.htmlUrl,
    }));

    const wrongSha = named.filter((run) => run.headSha !== sha);
    for (const run of wrongSha) {
      entry.failures.push({
        code: 'wrong-sha',
        detail: `check run "${name}" reports head_sha ${shortSha(run.headSha) || 'unknown'} `
          + `instead of the requested ${shortSha(sha)}; stale or unrelated run (run ${run.id ?? 'unknown'})`,
      });
    }

    const exact = named.filter((run) => run.headSha === sha);
    if (exact.length === 0 && wrongSha.length === 0) {
      entry.failures.push({
        code: 'missing-check',
        detail: `required check "${name}" has no check run for ${shortSha(sha)}; `
          + 'wait for the required workflow to run on this exact commit',
      });
    }

    const trustedRun = (run) => {
      const workflow = run.workflow;
      return Boolean(repo && workflow && run.appSlug === 'github-actions'
        && trusted.has(run.workflowPath)
        && workflow.head_sha === sha
        && workflow.repository?.full_name?.toLowerCase() === repo.toLowerCase()
        && workflow.head_repository?.full_name?.toLowerCase() === repo.toLowerCase()
        && workflow.head_repository?.fork === false
        && ['push', 'pull_request'].includes(workflow.event)
        && (!branch || (workflow.event === 'push' && workflow.head_branch === branch)));
    };
    // The most recent evidence is authoritative; an old success cannot hide a rerun failure.
    const candidates = exact.filter(trustedRun).sort((a, b) => Number(b.id) - Number(a.id));
    const trustedExact = candidates.slice(0, 1);
    const untrusted = exact.filter((run) => !trustedRun(run));
    const successful = trustedExact.filter(
      (run) => run.status === 'completed' && run.conclusion === 'success',
    );
    if (successful.length > 0) {
      entry.status = 'passed';
      entry.detail = `successful run from ${[...new Set(successful.map((run) => run.workflowPath))].join(', ')}`;
      continue;
    }

    for (const run of untrusted) {
      const identity = run.workflowPath ? `"${run.workflowPath}"` : 'an unknown workflow';
      entry.failures.push({
        code: 'untrusted-workflow',
        detail: `check run "${name}" for ${shortSha(sha)} comes from ${identity} `
          + `(run ${run.id ?? 'unknown'}); trusted workflows are ${trustedWorkflows.join(', ')}`,
      });
    }

    for (const run of trustedExact) {
      if (run.status !== 'completed') {
        entry.failures.push({
          code: 'incomplete',
          detail: `check run "${name}" is still ${run.status || 'pending'} for ${shortSha(sha)}; `
            + `wait for completion (run ${run.id ?? 'unknown'})`,
        });
        continue;
      }
      const mapping = CONCLUSION_FAILURES.get(run.conclusion);
      if (mapping) {
        entry.failures.push({
          code: mapping.code,
          detail: `check run "${name}" for ${shortSha(sha)} ${mapping.message} (run ${run.id ?? 'unknown'})`,
        });
        continue;
      }
      entry.failures.push({
        code: 'unsuccessful',
        detail: `check run "${name}" for ${shortSha(sha)} concluded `
          + `${run.conclusion ?? 'without a conclusion'}; success is required (run ${run.id ?? 'unknown'})`,
      });
    }

    entry.detail = entry.failures.map((failure) => failure.detail).join('; ');
    for (const failure of entry.failures) {
      report.failures.push({ check: name, code: failure.code, detail: failure.detail });
    }
  }

  report.passed = report.failures.length === 0;
  return report;
}

export function formatReadinessReport(report) {
  const lines = [
    `Exact-SHA readiness for ${report.sha}: ${report.passed ? 'PASS' : 'FAIL'}`,
  ];
  for (const check of report.checks) {
    if (check.status === 'passed') lines.push(`- ${check.name}: passed (${check.detail})`);
    else lines.push(`- ${check.name}: FAILED`);
  }
  for (const failure of report.failures) {
    lines.push(`failure [${failure.code}] ${failure.check}: ${failure.detail}`);
  }
  for (const warning of report.warnings) {
    lines.push(`warning [${warning.code}] ${warning.detail}`);
  }
  return lines.join('\n');
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function nextLink(linkHeader) {
  if (typeof linkHeader !== 'string') return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2] === 'next') return match[1];
  }
  return null;
}

async function fetchJson(fetchImpl, url, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'kordi-check-sha-readiness',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { headers });
  if (!response || typeof response.ok !== 'boolean') {
    throw new Error(`no HTTP response for ${url}`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') detail = `: ${body.message}`;
    } catch {
      detail = '';
    }
    throw new Error(
      `GitHub API request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''}) for ${url}${detail}`,
    );
  }
  return { body: await response.json(), response };
}

async function fetchPaginated(fetchImpl, url, token, collectionKey) {
  const items = [];
  let next = url;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const { body, response } = await fetchJson(fetchImpl, next, token);
    const pageItems = body?.[collectionKey];
    if (!Array.isArray(pageItems)) {
      throw new Error(`GitHub API response for ${next} is missing "${collectionKey}"`);
    }
    items.push(...pageItems);
    next = nextLink(headerValue(response, 'link'));
    pages += 1;
  }
  if (next) {
    throw new Error(`pagination limit of ${MAX_PAGES} pages exceeded for ${url}`);
  }
  return items;
}

export async function fetchReadinessInputs({ fetchImpl, apiUrl, repo, sha, token }) {
  const base = apiUrl.replace(/\/+$/, '');
  const checkRuns = await fetchPaginated(
    fetchImpl,
    `${base}/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    token,
    'check_runs',
  );
  const workflowRuns = await fetchPaginated(
    fetchImpl,
    `${base}/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
    token,
    'workflow_runs',
  );
  return { checkRuns, workflowRuns };
}

export function parseArguments(argv) {
  const options = { checks: [], workflows: [], json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    const separator = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (name) {
      case '--sha':
        options.sha = takeValue();
        break;
      case '--check':
        options.checks.push(takeValue());
        break;
      case '--workflow':
        options.workflows.push(takeValue());
        break;
      case '--branch':
        options.branch = takeValue();
        break;
      case '--repo':
        options.repo = takeValue();
        break;
      case '--api-url':
        options.apiUrl = takeValue();
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

export async function runCli(argv, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`[sha-readiness] error: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  const apiUrl = options.apiUrl ?? env.GITHUB_API_URL ?? DEFAULT_API_URL;
  const sha = options.sha;
  if (!repo || !REPO_PATTERN.test(repo)) {
    stderr.write('[sha-readiness] error: --repo <owner/name> or GITHUB_REPOSITORY is required\n');
    return 2;
  }
  if (!validateSha(sha)) {
    stderr.write(
      '[sha-readiness] error: --sha must be a full 40-character lowercase hexadecimal commit SHA\n',
    );
    return 2;
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!token && apiUrl.replace(/\/+$/, '') === DEFAULT_API_URL) {
    stderr.write('[sha-readiness] error: set GH_TOKEN or GITHUB_TOKEN to query the GitHub API\n');
    return 2;
  }

  const requiredChecks = options.checks.length > 0 ? options.checks : [...DEFAULT_REQUIRED_CHECKS];
  const trustedWorkflows = options.workflows.length > 0
    ? options.workflows
    : [...DEFAULT_TRUSTED_WORKFLOWS];

  let inputs;
  try {
    inputs = await fetchReadinessInputs({ fetchImpl, apiUrl, repo, sha, token });
  } catch (error) {
    stderr.write(`[sha-readiness] error: ${error.message}\n`);
    return 1;
  }

  const report = evaluateReadiness({
    sha,
    checkRuns: normalizeCheckRuns(inputs.checkRuns, inputs.workflowRuns),
    requiredChecks,
    trustedWorkflows,
    repo,
    branch: options.branch ?? null,
  });
  report.repo = repo;

  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatReadinessReport(report)}\n`);
  return report.passed ? 0 : 1;
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[sha-readiness] error: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
