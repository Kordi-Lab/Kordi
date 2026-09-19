#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PLAN_SCHEMA_VERSION = 1;
export const PRODUCTION_ENVIRONMENT = 'production';
export const DEFAULT_STACK = 'production-main';
export const CONFIRM_PHRASE = 'deploy-production';
export const HOST_WIDE_LOCK = 'host-wide';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PREFIXED_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const REFERENCE_DIGEST_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@sha256:([0-9a-f]{64})$/;
const BACKUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const STACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const WORKFLOW_PATTERN = /^https:\/\/[^\s]+$/;
const MAX_STATEMENT_LENGTH = 4096;

export const USAGE = `Usage:
  node scripts/production-deploy-guard.mjs \\
    --sha <40-hex> \\
    --artifact <sha256:<hex>|<reference>@sha256:<hex>> \\
    --backup <identifier> \\
    --rollback-plan <summary> \\
    --schema-compatibility <statement> \\
    [--actor <login>] [--workflow <url>] [--stack <id>] \\
    [--environment production] [--confirm ${CONFIRM_PHRASE}] \\
    [--out <path>] [--json]

Validates the protected production deployment inputs and emits a deterministic
deployment plan. Missing or malformed inputs fail closed. The plan is written
to --out, or printed as JSON with --json; otherwise a human summary is printed.
`;

function invalid(message) {
  return { ok: false, error: message };
}

function valid() {
  return { ok: true, error: null };
}

export function validateSha(value) {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) {
    return invalid('sha must be a full 40-character lowercase hexadecimal commit SHA');
  }
  return valid();
}

export function validateArtifactDigest(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    return invalid('artifact must be an immutable digest such as sha256:<64-hex> or <reference>@sha256:<64-hex>');
  }
  if (PREFIXED_DIGEST_PATTERN.test(text) || REFERENCE_DIGEST_PATTERN.test(text)) return valid();
  return invalid(
    'artifact must be pinned by an immutable sha256 digest '
      + '(sha256:<64-hex> or <reference>@sha256:<64-hex>); mutable tags are not accepted',
  );
}

export function artifactDigestOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const prefixed = PREFIXED_DIGEST_PATTERN.exec(text);
  if (prefixed) return `sha256:${prefixed[1]}`;
  const reference = REFERENCE_DIGEST_PATTERN.exec(text);
  if (reference) return `sha256:${reference[2]}`;
  return null;
}

export function validateBackupId(value) {
  if (typeof value !== 'string' || !BACKUP_PATTERN.test(value)) {
    return invalid('backup must be a non-empty identifier without whitespace (letters, digits, ".", "_", "-", ":", "/")');
  }
  return valid();
}

export function validateStackId(value) {
  if (typeof value !== 'string' || !STACK_PATTERN.test(value)) {
    return invalid('stack must be a lowercase identifier (letters, digits, ".", "_", "-")');
  }
  return valid();
}

export function validateActor(value) {
  if (typeof value !== 'string' || !ACTOR_PATTERN.test(value)) {
    return invalid('actor must be an account login without spaces or path separators');
  }
  return valid();
}

export function validateWorkflowUrl(value) {
  if (typeof value !== 'string' || !WORKFLOW_PATTERN.test(value) || value.length > 512) {
    return invalid('workflow must be an https URL');
  }
  return valid();
}

export function validateStatement(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(`${label} must be a non-empty statement`);
  }
  if (value.length > MAX_STATEMENT_LENGTH) {
    return invalid(`${label} must be at most ${MAX_STATEMENT_LENGTH} characters`);
  }
  return valid();
}

export function validateConfirm(value) {
  if (value === undefined || value === null || value === '') return valid();
  if (value !== CONFIRM_PHRASE) {
    return invalid(`confirm must be exactly "${CONFIRM_PHRASE}" when provided`);
  }
  return valid();
}

export function validateDeploymentInputs(inputs = {}) {
  const errors = [];
  const checks = [
    ['sha', validateSha(inputs.sha)],
    ['artifact', validateArtifactDigest(inputs.artifact)],
    ['backup', validateBackupId(inputs.backup)],
    ['rollbackPlan', validateStatement(inputs.rollbackPlan, 'rollback plan')],
    ['schemaCompatibility', validateStatement(inputs.schemaCompatibility, 'schema compatibility')],
    ['stack', inputs.stack === undefined ? valid() : validateStackId(inputs.stack)],
    ['environment', inputs.environment === undefined || inputs.environment === PRODUCTION_ENVIRONMENT
      ? valid()
      : invalid(`environment must be ${PRODUCTION_ENVIRONMENT}`)],
    ['actor', inputs.actor === undefined || inputs.actor === null || inputs.actor === ''
      ? valid()
      : validateActor(inputs.actor)],
    ['workflow', inputs.workflow === undefined || inputs.workflow === null || inputs.workflow === ''
      ? valid()
      : validateWorkflowUrl(inputs.workflow)],
    ['confirm', validateConfirm(inputs.confirm)],
  ];
  for (const [field, result] of checks) {
    if (!result.ok) errors.push(`${field}: ${result.error}`);
  }
  return { ok: errors.length === 0, errors };
}

export function buildDeploymentPlan(inputs) {
  const validation = validateDeploymentInputs(inputs);
  if (!validation.ok) {
    throw new Error(`invalid production deployment inputs:\n${validation.errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  const stack = inputs.stack ?? DEFAULT_STACK;
  const artifactDigest = artifactDigestOf(inputs.artifact);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    environment: PRODUCTION_ENVIRONMENT,
    stack,
    sha: inputs.sha,
    artifact: inputs.artifact.trim(),
    artifactDigest,
    backup: inputs.backup,
    rollbackPlan: inputs.rollbackPlan,
    schemaCompatibility: inputs.schemaCompatibility,
    actor: inputs.actor ?? null,
    workflow: inputs.workflow ?? null,
    confirmed: inputs.confirm === CONFIRM_PHRASE,
    generatedBy: 'scripts/production-deploy-guard.mjs',
    steps: [
      { id: 'acquire-lock', summary: 'Acquire the shared host-wide deployment lock', lock: HOST_WIDE_LOCK },
      { id: 'verify-revision', summary: 'Verify the source tree is checked out at the approved revision', revision: inputs.sha },
      { id: 'prepare-deployment', summary: 'Create an isolated source-sync and build directory for this deployment' },
      { id: 'verify-artifact-presence', summary: 'Verify the approved artifact is present in the host image store', artifact: artifactDigest },
      { id: 'sync-and-build', summary: 'Sync the exact revision and build on the production host' },
      { id: 'deploy-artifact', summary: 'Deploy through the transport-aware operator wrapper', artifact: artifactDigest, revision: inputs.sha },
      { id: 'verify-artifact', summary: 'Verify the deployed image digest matches the approved immutable artifact', artifact: artifactDigest },
      { id: 'verify-rollout', summary: 'Verify the production rollout completes', workload: 'kordi-cloud-server' },
      { id: 'verify-health', summary: 'Verify health through the cluster and the public product origin' },
      { id: 'verify-smoke', summary: 'Verify the production smoke checks' },
      { id: 'record-deployment', summary: 'Record the deployment outcome before releasing the lock', environment: PRODUCTION_ENVIRONMENT, backup: inputs.backup },
      { id: 'release-lock', summary: 'Release the shared host-wide deployment lock', lock: HOST_WIDE_LOCK },
    ],
  };
}

export function renderPlan(plan) {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function formatPlanSummary(plan) {
  return [
    `Production deployment plan: ${plan.sha.slice(0, 12)} -> ${plan.environment}/${plan.stack}`,
    `  artifact:             ${plan.artifact}`,
    `  artifact digest:      ${plan.artifactDigest}`,
    `  backup:               ${plan.backup}`,
    `  rollback plan:        ${plan.rollbackPlan}`,
    `  schema compatibility: ${plan.schemaCompatibility}`,
    `  actor:                ${plan.actor ?? 'not recorded'}`,
    `  workflow:             ${plan.workflow ?? 'not recorded'}`,
    `  confirmed:            ${plan.confirmed}`,
    '  steps:',
    ...plan.steps.map((step, index) => `    ${index + 1}. [${step.id}] ${step.summary}`),
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { help: false, json: false };
  const valueFlags = new Map([
    ['--sha', 'sha'],
    ['--artifact', 'artifact'],
    ['--backup', 'backup'],
    ['--rollback-plan', 'rollbackPlan'],
    ['--schema-compatibility', 'schemaCompatibility'],
    ['--actor', 'actor'],
    ['--workflow', 'workflow'],
    ['--stack', 'stack'],
    ['--environment', 'environment'],
    ['--confirm', 'confirm'],
    ['--out', 'out'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    const separator = token.indexOf('=');
    const name = separator === -1 ? token : token.slice(0, separator);
    const key = valueFlags.get(name);
    if (!key) throw new Error(`Unknown argument: ${token}`);
    let value = separator === -1 ? undefined : token.slice(separator + 1);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
      index += 1;
    }
    options[key] = value;
  }
  return options;
}

export function runCli(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`[deploy-guard] error: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  const validation = validateDeploymentInputs(options);
  if (!validation.ok) {
    stderr.write('[deploy-guard] invalid production deployment inputs:\n');
    for (const error of validation.errors) stderr.write(`  - ${error}\n`);
    return 1;
  }

  const plan = buildDeploymentPlan(options);
  if (options.out) {
    const resolved = path.resolve(cwd, options.out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, renderPlan(plan), { encoding: 'utf8', mode: 0o600 });
    stdout.write(`${formatPlanSummary(plan)}\n`);
    stdout.write(`[deploy-guard] wrote deployment plan to ${resolved}\n`);
    return 0;
  }
  if (options.json) {
    stdout.write(renderPlan(plan));
    return 0;
  }
  stdout.write(`${formatPlanSummary(plan)}\n`);
  return 0;
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  process.exitCode = runCli(process.argv.slice(2));
}
