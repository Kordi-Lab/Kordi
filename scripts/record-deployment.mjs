#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RECORD_SCHEMA_VERSION = 1;
export const SUPPORTED_ENVIRONMENTS = Object.freeze(['dev', 'production']);
export const RECORDS_DIRECTORY = 'deploy/deployment-records';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const STACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const WORKFLOW_PATTERN = /^https:\/\/[^\s]+$/;
const PREFIXED_DIGEST_PATTERN = /^(sha256|sha384|sha512):([0-9a-f]+)$/;
const REFERENCE_DIGEST_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@(sha256|sha384|sha512):([0-9a-f]+)$/;
const BARE_DIGEST_PATTERN = /^[0-9a-f]+$/;
const DIGEST_HEX_LENGTHS = Object.freeze({ sha256: 64, sha384: 96, sha512: 128 });
const MAX_VERIFICATION_BYTES = 16384;

export const USAGE = `Usage:
  node scripts/record-deployment.mjs \\
    --environment <dev|production> \\
    --stack <id> \\
    --sha <full-40-char-sha> \\
    --actor <login> \\
    --artifact <digest> \\
    [--backup <id>] \\
    [--verification <summary|file>] \\
    [--rollback <outcome>] \\
    [--workflow <url>] \\
    [--out <path>] \\
    [--dry-run] [--force]

Writes a deterministic JSON deployment record. Free-text fields are redacted
for obvious credential patterns; the record is never written twice unless
--force is passed.
`;

function invalid(message) {
  return { ok: false, error: message };
}

function valid() {
  return { ok: true, error: null };
}

export function validateEnvironment(value) {
  if (!SUPPORTED_ENVIRONMENTS.includes(value)) {
    return invalid(`environment must be one of: ${SUPPORTED_ENVIRONMENTS.join(', ')}`);
  }
  return valid();
}

export function validateStackId(value) {
  if (typeof value !== 'string' || !STACK_PATTERN.test(value)) {
    return invalid('stack must be a lowercase identifier (letters, digits, ".", "_", "-")');
  }
  return valid();
}

export function validateSha(value) {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) {
    return invalid('sha must be a full 40-character lowercase hexadecimal commit SHA');
  }
  return valid();
}

export function validateActor(value) {
  if (typeof value !== 'string' || !ACTOR_PATTERN.test(value)) {
    return invalid('actor must be an account login without spaces or path separators');
  }
  return valid();
}

export function validateArtifactDigest(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    return invalid('artifact must be a digest such as sha256:<hex> or <reference>@sha256:<hex>');
  }
  if (/\s/.test(text) || text.length > 320) {
    return invalid('artifact digest must not contain whitespace and must be at most 320 characters');
  }
  const prefixed = PREFIXED_DIGEST_PATTERN.exec(text);
  if (prefixed) {
    return prefixed[2].length === DIGEST_HEX_LENGTHS[prefixed[1]]
      ? valid()
      : invalid(`artifact digest has the wrong hex length for ${prefixed[1]}`);
  }
  const reference = REFERENCE_DIGEST_PATTERN.exec(text);
  if (reference) {
    return reference[3].length === DIGEST_HEX_LENGTHS[reference[2]]
      ? valid()
      : invalid(`artifact digest has the wrong hex length for ${reference[2]}`);
  }
  if (BARE_DIGEST_PATTERN.test(text) && Object.values(DIGEST_HEX_LENGTHS).includes(text.length)) {
    return valid();
  }
  return invalid(
    'artifact must be sha256:<hex>, a bare 64/96/128-character hex digest, '
      + 'or an image reference ending in @sha256:<hex>',
  );
}

export function validateWorkflowUrl(value) {
  if (typeof value !== 'string' || !WORKFLOW_PATTERN.test(value) || value.length > 512) {
    return invalid('workflow must be an https URL');
  }
  return valid();
}

function validateOptionalText(value, { label, maxLength }) {
  if (value === undefined || value === null) return valid();
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(`${label} must be a non-empty value when provided`);
  }
  if (value.length > maxLength) {
    return invalid(`${label} must be at most ${maxLength} characters`);
  }
  return valid();
}

export function validateDeploymentOptions(options) {
  const errors = [];
  const checks = [
    ['environment', validateEnvironment(options.environment)],
    ['stack', validateStackId(options.stack)],
    ['sha', validateSha(options.sha)],
    ['actor', validateActor(options.actor)],
    ['artifact', options.failed && !options.artifact ? valid() : validateArtifactDigest(options.artifact)],
    ['backup', validateOptionalText(options.backup, { label: 'backup', maxLength: 512 })],
    ['verification', validateOptionalText(options.verification, {
      label: 'verification',
      maxLength: MAX_VERIFICATION_BYTES,
    })],
    ['rollback', validateOptionalText(options.rollback, { label: 'rollback', maxLength: 4096 })],
    ['workflow', options.workflow === undefined ? valid() : validateWorkflowUrl(options.workflow)],
  ];
  for (const [field, result] of checks) {
    if (!result.ok) errors.push(`${field}: ${result.error}`);
  }
  return { ok: errors.length === 0, errors };
}

const KEY_VALUE_REDACTION =
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(\s*[:=]\s*)("?)([^\s"',;]+)\3/gi;

export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(KEY_VALUE_REDACTION, (match, name, separator, quote) => `${name}${separator}${quote}[REDACTED]${quote}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, '$1:[REDACTED]@');
}

function normalizeOptional(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

export function resolveVerificationInput(value, { cwd = process.cwd() } = {}) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const candidate = path.resolve(cwd, text);
  let info;
  try {
    info = fs.statSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return text;
    throw error;
  }
  if (!info.isFile()) return text;
  const content = fs.readFileSync(candidate, 'utf8');
  if (content.length > MAX_VERIFICATION_BYTES) {
    throw new Error(`verification file exceeds ${MAX_VERIFICATION_BYTES} bytes: ${text}`);
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error(`verification file is empty: ${text}`);
  return trimmed;
}

export function buildRecord(options, now = new Date()) {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    environment: options.environment,
    stack: options.stack,
    revision: options.sha,
    actor: options.actor,
    artifact: options.artifact ?? null,
    ...(options.failed ? { outcome: 'failure' } : {}),
    backup: redactText(normalizeOptional(options.backup)),
    verification: redactText(normalizeOptional(options.verification)),
    rollback: redactText(normalizeOptional(options.rollback)),
    workflow: redactText(normalizeOptional(options.workflow)),
    recordedAt: now.toISOString(),
  };
}

export function renderRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function formatRecordTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function recordFilename(record) {
  const timestamp = formatRecordTimestamp(new Date(record.recordedAt));
  return `${timestamp}-${record.revision.slice(0, 12)}.json`;
}

export function defaultRecordPath(record, root) {
  return path.join(root, RECORDS_DIRECTORY, record.environment, recordFilename(record));
}

export function resolveRecordPath(record, { root, out, cwd = process.cwd() } = {}) {
  if (out === undefined || out === null) return defaultRecordPath(record, root);
  const resolved = path.resolve(cwd, out);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, recordFilename(record));
  }
  return resolved;
}

export function formatRecordSummary(record, recordPath) {
  return [
    `Deployment record: ${recordPath}`,
    `  environment:  ${record.environment}`,
    `  stack:        ${record.stack}`,
    `  revision:     ${record.revision}`,
    `  actor:        ${record.actor}`,
    `  artifact:     ${record.artifact}`,
    `  backup:       ${record.backup ?? 'not recorded'}`,
    `  verification: ${record.verification ?? 'not recorded'}`,
    `  rollback:     ${record.rollback ?? 'not recorded'}`,
    `  workflow:     ${record.workflow ?? 'not recorded'}`,
    `  recorded at:  ${record.recordedAt}`,
  ].join('\n');
}

export function writeRecordFile(recordPath, content, { force = false } = {}) {
  if (!force && fs.existsSync(recordPath)) {
    throw new Error(`deployment record already exists at ${recordPath}; pass --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, content, { encoding: 'utf8', mode: 0o600 });
  return recordPath;
}

const VALUE_FLAGS = new Map([
  ['--environment', 'environment'],
  ['--stack', 'stack'],
  ['--sha', 'sha'],
  ['--actor', 'actor'],
  ['--artifact', 'artifact'],
  ['--backup', 'backup'],
  ['--verification', 'verification'],
  ['--rollback', 'rollback'],
  ['--workflow', 'workflow'],
  ['--out', 'out'],
]);

export function parseArguments(argv) {
  const options = { dryRun: false, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--failed') {
      options.failed = true;
      continue;
    }
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = VALUE_FLAGS.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function defaultRepoRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function runCli(argv, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  now = new Date(),
  repoRoot = defaultRepoRoot(),
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`[deploy-record] error: ${error.message}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  try {
    options.verification = resolveVerificationInput(options.verification, { cwd });
    const validation = validateDeploymentOptions(options);
    if (!validation.ok) {
      stderr.write('[deploy-record] invalid input:\n');
      for (const error of validation.errors) stderr.write(`  - ${error}\n`);
      return 1;
    }
    const record = buildRecord(options, now);
    const recordPath = resolveRecordPath(record, { root: repoRoot, out: options.out, cwd });
    const content = renderRecord(record);
    if (options.dryRun) {
      stdout.write(`[deploy-record] dry run: no file written; target ${recordPath}\n`);
      stdout.write(content);
      stdout.write(`${formatRecordSummary(record, recordPath)}\n`);
      return 0;
    }
    writeRecordFile(recordPath, content, { force: options.force });
    stdout.write(`${formatRecordSummary(record, recordPath)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`[deploy-record] error: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv.slice(2));
}
