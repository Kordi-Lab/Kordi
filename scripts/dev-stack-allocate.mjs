#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REGISTRY_VERSION = 1;
export const DEFAULT_REGISTRY_PATH = 'deploy/dev/stack-allocations.json';
export const STACK_ID_MIN_LENGTH = 2;
export const STACK_ID_MAX_LENGTH = 32;
export const STACK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const ACTOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const PORT_RANGE_SIZE = 900;
export const PORT_BASES = Object.freeze({
  api: 17100,
  minio: 19100,
  minioConsole: 20100,
});

export const RESERVED_STACK_IDS = Object.freeze([
  'default',
  'host-wide',
  'main',
  'operator',
  'prod',
  'production',
  'shared',
  'staging',
]);

export const USAGE = `Usage:
  node scripts/dev-stack-allocate.mjs validate-inputs --stack <id> --sha <full-40-char-sha> [--json]
  node scripts/dev-stack-allocate.mjs check --stack <id> --actor <login> [--registry <path>] [--now <timestamp>] [--json]
  node scripts/dev-stack-allocate.mjs plan --stack <id> --actor <login> [--registry <path>] [--now <timestamp>] [--json]
  node scripts/dev-stack-allocate.mjs list [--registry <path>] [--now <timestamp>] [--json]

Validates development stack allocations from the trusted registry at
${DEFAULT_REGISTRY_PATH}. The registry is read-only here: allocation changes
happen through review, never through this command.

Subcommands:
  validate-inputs  Validate a stack identifier and a full commit SHA.
  check            Validate that <actor> may deploy <stack> now.
  plan             Print the deterministic runtime plan for an allowed stack.
  list             List allocations and whether they are active.

Exit codes: 0 allowed/valid, 1 denied or invalid, 2 usage error.
`;

function invalid(message) {
  return { ok: false, error: message };
}

function valid() {
  return { ok: true, error: null };
}

export function validateStackId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('stack id is required');
  }
  if (value.length < STACK_ID_MIN_LENGTH || value.length > STACK_ID_MAX_LENGTH) {
    return invalid(`stack id must be ${STACK_ID_MIN_LENGTH}-${STACK_ID_MAX_LENGTH} characters`);
  }
  if (!STACK_ID_PATTERN.test(value)) {
    return invalid('stack id must use lowercase letters, digits, and dashes, and start and end with a letter or digit');
  }
  if (value.includes('--')) {
    return invalid('stack id must not contain consecutive dashes');
  }
  if (RESERVED_STACK_IDS.includes(value)) {
    return invalid(`stack id '${value}' is reserved`);
  }
  return valid();
}

export function validateActor(value) {
  if (typeof value !== 'string' || !ACTOR_PATTERN.test(value)) {
    return invalid('actor must be a GitHub account login');
  }
  return valid();
}

export function validateSha(value) {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) {
    return invalid('sha must be a full 40-character lowercase hexadecimal commit SHA');
  }
  return valid();
}

export function validateTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    return invalid('timestamp must be an ISO-8601 UTC value such as 2026-09-19T00:00:00Z');
  }
  return valid();
}

export function deriveStackPlan(stack) {
  const digest = createHash('sha256').update(stack).digest('hex');
  const offset = Number.parseInt(digest.slice(0, 8), 16) % PORT_RANGE_SIZE;
  return {
    stack,
    composeProject: `kordi-${stack}`,
    lock: `stack-${stack}`,
    workdirName: stack,
    envFile: 'deploy/dev/.env',
    ports: {
      api: PORT_BASES.api + offset,
      minio: PORT_BASES.minio + offset,
      minioConsole: PORT_BASES.minioConsole + offset,
    },
  };
}

export const REGISTRY_DOCUMENT_KEYS = Object.freeze(['version', 'stacks']);
export const REGISTRY_ENTRY_KEYS = Object.freeze(['id', 'owner', 'createdAt', 'expiresAt']);

function unknownKeys(value, allowedKeys) {
  return Object.keys(value).filter((key) => !allowedKeys.includes(key));
}

export function validateRegistryDocument(document) {
  const errors = [];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, errors: ['registry must be a JSON object'], stacks: [] };
  }
  for (const key of unknownKeys(document, REGISTRY_DOCUMENT_KEYS)) {
    errors.push(`registry has an unknown field '${key}'`);
  }
  if (document.version !== REGISTRY_VERSION) {
    errors.push(`registry version must be ${REGISTRY_VERSION}`);
  }
  if (!Array.isArray(document.stacks)) {
    errors.push('registry stacks must be an array');
    return { ok: false, errors, stacks: [] };
  }
  const seen = new Set();
  const stacks = [];
  for (let index = 0; index < document.stacks.length; index += 1) {
    const entry = document.stacks[index];
    const label = `stacks[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const key of unknownKeys(entry, REGISTRY_ENTRY_KEYS)) {
      errors.push(`${label} has an unknown field '${key}'`);
    }
    const idResult = validateStackId(entry.id);
    if (!idResult.ok) errors.push(`${label}.id: ${idResult.error}`);
    if (typeof entry.id === 'string') {
      if (seen.has(entry.id)) errors.push(`${label}.id: duplicate allocation for '${entry.id}'`);
      seen.add(entry.id);
    }
    const ownerResult = validateActor(entry.owner);
    if (!ownerResult.ok) errors.push(`${label}.owner: ${ownerResult.error}`);
    const createdResult = validateTimestamp(entry.createdAt);
    if (!createdResult.ok) errors.push(`${label}.createdAt: ${createdResult.error}`);
    if (entry.expiresAt !== undefined) {
      const expiresResult = validateTimestamp(entry.expiresAt);
      if (!expiresResult.ok) {
        errors.push(`${label}.expiresAt: ${expiresResult.error}`);
      } else if (createdResult.ok && Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt)) {
        errors.push(`${label}.expiresAt: must be later than createdAt`);
      }
    }
    if (idResult.ok && ownerResult.ok && createdResult.ok) {
      stacks.push({
        id: entry.id,
        owner: entry.owner,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt ?? null,
      });
    }
  }
  return { ok: errors.length === 0, errors, stacks };
}

export function loadRegistry(registryPath) {
  let raw;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch {
    return { ok: false, errors: [`registry file is missing or unreadable: ${registryPath}`], stacks: [] };
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`registry file is not valid JSON: ${registryPath}: ${error.message}`], stacks: [] };
  }
  return validateRegistryDocument(document);
}

export function allocationIsActive(allocation, now = new Date()) {
  if (allocation.expiresAt === null) return true;
  return Date.parse(allocation.expiresAt) > now.getTime();
}

export function checkAllocation(registryResult, { stack, actor, now = new Date() } = {}) {
  const errors = [];
  const stackResult = validateStackId(stack);
  if (!stackResult.ok) errors.push(stackResult.error);
  const actorResult = validateActor(actor);
  if (!actorResult.ok) errors.push(actorResult.error);
  if (!registryResult.ok) errors.push(...registryResult.errors);
  if (errors.length > 0) {
    return { ok: false, errors, allocation: null, plan: null };
  }
  const allocation = registryResult.stacks.find((entry) => entry.id === stack) ?? null;
  if (!allocation) {
    errors.push(`stack '${stack}' is not allocated in the registry`);
    return { ok: false, errors, allocation: null, plan: null };
  }
  if (allocation.owner.toLowerCase() !== actor.toLowerCase()) {
    errors.push(`stack '${stack}' is owned by '${allocation.owner}', not '${actor}'`);
  }
  if (!allocationIsActive(allocation, now)) {
    errors.push(`allocation for stack '${stack}' expired at ${allocation.expiresAt}`);
  }
  const plan = deriveStackPlan(stack);
  for (const entry of registryResult.stacks) {
    if (entry.id === stack) continue;
    if (!allocationIsActive(entry, now)) continue;
    const other = deriveStackPlan(entry.id);
    if (other.ports.api === plan.ports.api) {
      errors.push(`stack '${stack}' port plan collides with active stack '${entry.id}'`);
    }
  }
  return { ok: errors.length === 0, errors, allocation, plan };
}

export function listAllocations(registryResult, now = new Date()) {
  return registryResult.stacks.map((entry) => ({
    ...entry,
    active: allocationIsActive(entry, now),
    plan: deriveStackPlan(entry.id),
  }));
}

function parseArguments(argv) {
  const options = { command: null, json: false, help: false };
  const valueFlags = new Map([
    ['--stack', 'stack'],
    ['--actor', 'actor'],
    ['--sha', 'sha'],
    ['--registry', 'registry'],
    ['--now', 'now'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (key) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (options.command !== null) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    options.command = argument;
  }
  return options;
}

function resolveRegistryPath(options, cwd) {
  return path.resolve(cwd, options.registry ?? DEFAULT_REGISTRY_PATH);
}

function resolveNow(options) {
  if (options.now === undefined) return new Date();
  return new Date(options.now);
}

function emit(stream, options, payload, human) {
  stream.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${human}\n`);
}

function runValidateInputs(options, context) {
  const errors = [];
  const stackResult = validateStackId(options.stack);
  if (!stackResult.ok) errors.push(stackResult.error);
  const shaResult = validateSha(options.sha);
  if (!shaResult.ok) errors.push(shaResult.error);
  if (errors.length > 0) {
    emit(context.stderr, options, { ok: false, errors }, `invalid inputs:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    return 1;
  }
  emit(
    context.stdout,
    options,
    { ok: true, errors: [], stack: options.stack, sha: options.sha },
    `valid inputs: stack '${options.stack}' revision ${options.sha}`,
  );
  return 0;
}

function runCheck(options, context) {
  const now = resolveNow(options);
  const registryResult = loadRegistry(resolveRegistryPath(options, context.cwd));
  const result = checkAllocation(registryResult, { stack: options.stack, actor: options.actor, now });
  const payload = {
    ok: result.ok,
    stack: options.stack ?? null,
    actor: options.actor ?? null,
    errors: result.errors,
    allocation: result.allocation,
    plan: result.plan,
  };
  if (!result.ok) {
    emit(context.stderr, options, payload, `denied:\n${result.errors.map((error) => `  - ${error}`).join('\n')}`);
    return 1;
  }
  emit(
    context.stdout,
    options,
    payload,
    `allowed: stack '${result.allocation.id}' is allocated to '${result.allocation.owner}'`,
  );
  return 0;
}

function runPlan(options, context) {
  const now = resolveNow(options);
  const registryResult = loadRegistry(resolveRegistryPath(options, context.cwd));
  const result = checkAllocation(registryResult, { stack: options.stack, actor: options.actor, now });
  if (!result.ok) {
    emit(
      context.stderr,
      options,
      { ok: false, errors: result.errors, allocation: null, plan: null },
      `denied:\n${result.errors.map((error) => `  - ${error}`).join('\n')}`,
    );
    return 1;
  }
  const payload = {
    ok: true,
    errors: [],
    allocation: result.allocation,
    plan: result.plan,
  };
  const human = [
    `plan for stack '${result.plan.stack}':`,
    `  compose project: ${result.plan.composeProject}`,
    `  lock:            ${result.plan.lock}`,
    `  workdir name:    ${result.plan.workdirName}`,
    `  env file:        ${result.plan.envFile}`,
    `  api port:        ${result.plan.ports.api}`,
    `  minio port:      ${result.plan.ports.minio}`,
    `  minio console:   ${result.plan.ports.minioConsole}`,
  ].join('\n');
  emit(context.stdout, options, payload, human);
  return 0;
}

function runList(options, context) {
  const now = resolveNow(options);
  const registryResult = loadRegistry(resolveRegistryPath(options, context.cwd));
  if (!registryResult.ok) {
    emit(
      context.stderr,
      options,
      { ok: false, errors: registryResult.errors, allocations: [] },
      `registry is invalid:\n${registryResult.errors.map((error) => `  - ${error}`).join('\n')}`,
    );
    return 1;
  }
  const allocations = listAllocations(registryResult, now);
  const human = allocations.length === 0
    ? 'no stack allocations are registered'
    : allocations
      .map((entry) => `${entry.id} owner=${entry.owner} status=${entry.active ? 'active' : 'expired'} expiresAt=${entry.expiresAt ?? 'never'}`)
      .join('\n');
  emit(context.stdout, options, { ok: true, errors: [], allocations }, human);
  return 0;
}

export function runCli(argv, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`[dev-stack] ${error.message}\n`);
    return 2;
  }
  if (options.help || options.command === null) {
    stdout.write(USAGE);
    return options.help ? 0 : 2;
  }
  const context = { cwd, stdout, stderr };
  switch (options.command) {
    case 'validate-inputs':
      return runValidateInputs(options, context);
    case 'check':
      return runCheck(options, context);
    case 'plan':
      return runPlan(options, context);
    case 'list':
      return runList(options, context);
    default:
      stderr.write(`[dev-stack] unknown subcommand: ${options.command}\n`);
      return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv.slice(2));
}
