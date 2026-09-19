#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_REGISTRY_PATH,
  PORT_BASES,
  RESERVED_STACK_IDS,
  checkAllocation,
  deriveStackPlan,
  listAllocations,
  loadRegistry,
  validateRegistryDocument,
  validateSha,
  validateStackId,
} from './dev-stack-allocate.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptPath = join(repoRoot, 'scripts/dev-stack-allocate.mjs');
const NOW = new Date('2026-09-19T12:00:00Z');
const SHA = 'a'.repeat(40);

function makeDirectory() {
  return mkdtempSync(join(tmpdir(), 'kordi-stack-allocate-test-'));
}

function writeRegistry(directory, document) {
  const file = join(directory, 'stack-allocations.json');
  fs.writeFileSync(file, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

function allocation(overrides = {}) {
  return {
    id: 'issue-1234',
    owner: 'developer-one',
    createdAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function activeRegistry(stacks) {
  return { version: 1, stacks };
}

function checkWith(stacks, options = {}) {
  const result = validateRegistryDocument(activeRegistry(stacks));
  assert.equal(result.ok, true, result.errors.join('; '));
  return checkAllocation(result, {
    stack: options.stack ?? 'issue-1234',
    actor: options.actor ?? 'developer-one',
    now: options.now ?? NOW,
  });
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function findCollidingId(baseId) {
  const target = deriveStackPlan(baseId).ports.api;
  for (let index = 0; index < 10000; index += 1) {
    const candidate = `collide-${index}`;
    if (deriveStackPlan(candidate).ports.api === target) return candidate;
  }
  throw new Error(`no collision fixture found for ${baseId}`);
}

test('committed allocation registry is present and valid', () => {
  const result = loadRegistry(join(repoRoot, DEFAULT_REGISTRY_PATH));
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('stack id validation accepts bounded lowercase identifiers', () => {
  for (const id of ['ab', 'issue-1234', 'stack-01', 'a'.repeat(32)]) {
    const result = validateStackId(id);
    assert.equal(result.ok, true, `${id}: ${result.error}`);
  }
});

test('stack id validation rejects malformed, reserved, and unbounded identifiers', () => {
  for (const id of [
    '',
    'a',
    'Issue-1234',
    'issue_1234',
    'issue.1234',
    '-issue',
    'issue-',
    'issue--1234',
    'a'.repeat(33),
    'a b',
    ...RESERVED_STACK_IDS,
  ]) {
    const result = validateStackId(id);
    assert.equal(result.ok, false, `expected rejection: ${id}`);
  }
});

test('sha validation requires a full lowercase commit SHA', () => {
  assert.equal(validateSha(SHA).ok, true);
  for (const value of ['', 'abc', 'A'.repeat(40), `${SHA}0`, undefined]) {
    assert.equal(validateSha(value).ok, false);
  }
});

test('missing, malformed, and version-mismatched registries fail closed', () => {
  const directory = makeDirectory();
  try {
    const missing = loadRegistry(join(directory, 'absent.json'));
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /missing or unreadable/);

    const malformedPath = writeRegistry(directory, '{ not json');
    const malformed = loadRegistry(malformedPath);
    assert.equal(malformed.ok, false);
    assert.match(malformed.errors.join('\n'), /not valid JSON/);

    const wrongVersion = validateRegistryDocument({ version: 2, stacks: [] });
    assert.equal(wrongVersion.ok, false);
    assert.match(wrongVersion.errors.join('\n'), /version must be 1/);

    const wrongShape = validateRegistryDocument({ version: 1, stacks: {} });
    assert.equal(wrongShape.ok, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('registry validation rejects duplicate, reserved, and malformed entries', () => {
  const duplicate = validateRegistryDocument(activeRegistry([
    allocation(),
    allocation({ owner: 'developer-two' }),
  ]));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join('\n'), /duplicate allocation/);

  const reserved = validateRegistryDocument(activeRegistry([allocation({ id: 'production' })]));
  assert.equal(reserved.ok, false);
  assert.match(reserved.errors.join('\n'), /reserved/);

  const malformed = validateRegistryDocument(activeRegistry([
    allocation({ owner: '', createdAt: 'yesterday' }),
    { id: 'issue-2222', owner: 'developer-one', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z' },
  ]));
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join('\n'), /owner/);
  assert.match(malformed.errors.join('\n'), /createdAt/);
  assert.match(malformed.errors.join('\n'), /expiresAt/);
});

test('registry validation rejects unknown fields', () => {
  const document = validateRegistryDocument({ version: 1, stacks: [allocation()], extra: true });
  assert.equal(document.ok, false);
  assert.match(document.errors.join('\n'), /unknown field 'extra'/);

  const entry = validateRegistryDocument(activeRegistry([allocation({ ports: { api: 1 } })]));
  assert.equal(entry.ok, false);
  assert.match(entry.errors.join('\n'), /unknown field 'ports'/);
});

test('ownership is enforced case-insensitively against the registry', () => {
  const allowed = checkWith([allocation()], { actor: 'Developer-One' });
  assert.equal(allowed.ok, true, allowed.errors.join('; '));
  assert.equal(allowed.allocation.owner, 'developer-one');

  const denied = checkWith([allocation()], { actor: 'developer-two' });
  assert.equal(denied.ok, false);
  assert.match(denied.errors.join('\n'), /owned by 'developer-one'/);
});

test('unallocated and expired stacks are denied', () => {
  const unallocated = checkWith([allocation()], { stack: 'issue-9999' });
  assert.equal(unallocated.ok, false);
  assert.match(unallocated.errors.join('\n'), /not allocated/);

  const expired = checkWith([allocation({ expiresAt: '2026-09-18T00:00:00Z' })]);
  assert.equal(expired.ok, false);
  assert.match(expired.errors.join('\n'), /expired at 2026-09-18T00:00:00Z/);

  const future = checkWith([allocation({ expiresAt: '2026-10-01T00:00:00Z' })]);
  assert.equal(future.ok, true, future.errors.join('; '));

  const never = checkWith([allocation()]);
  assert.equal(never.ok, true, never.errors.join('; '));
});

test('active allocations may not share a derived port plan', () => {
  const collisionId = findCollidingId('issue-1234');
  const colliding = checkWith([
    allocation(),
    allocation({ id: collisionId, owner: 'developer-two' }),
  ]);
  assert.equal(colliding.ok, false);
  assert.match(colliding.errors.join('\n'), new RegExp(`collides with active stack '${collisionId}'`));

  const expiredCollision = checkWith([
    allocation(),
    allocation({ id: collisionId, owner: 'developer-two', expiresAt: '2026-09-18T00:00:00Z' }),
  ]);
  assert.equal(expiredCollision.ok, true, expiredCollision.errors.join('; '));
});

test('derived plans are deterministic and bounded to the reserved port ranges', () => {
  const plan = deriveStackPlan('alpha-one');
  assert.deepEqual(plan, {
    stack: 'alpha-one',
    composeProject: 'kordi-alpha-one',
    lock: 'stack-alpha-one',
    workdirName: 'alpha-one',
    envFile: 'deploy/dev/.env',
    ports: {
      api: 17979,
      minio: 19979,
      minioConsole: 20979,
    },
  });
  assert.deepEqual(deriveStackPlan('alpha-one'), plan);
  assert.ok(plan.ports.api >= PORT_BASES.api && plan.ports.api < PORT_BASES.api + 900);
  assert.ok(plan.ports.minio >= PORT_BASES.minio && plan.ports.minio < PORT_BASES.minio + 900);
  assert.ok(plan.ports.minioConsole >= PORT_BASES.minioConsole && plan.ports.minioConsole < PORT_BASES.minioConsole + 900);
});

test('list reports active and expired allocations', () => {
  const registry = validateRegistryDocument(activeRegistry([
    allocation(),
    allocation({ id: 'issue-5678', owner: 'developer-two', expiresAt: '2026-09-18T00:00:00Z' }),
  ]));
  const entries = listAllocations(registry, NOW);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].active, true);
  assert.equal(entries[1].active, false);
  assert.equal(entries[0].plan.composeProject, 'kordi-issue-1234');
});

test('validate-inputs accepts valid inputs and rejects invalid ones', () => {
  const allowed = runCli(['validate-inputs', '--stack', 'issue-1234', '--sha', SHA]);
  assert.equal(allowed.status, 0, allowed.stderr);

  const denied = runCli(['validate-inputs', '--stack', 'Issue-1234', '--sha', 'abc']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /stack id/);
  assert.match(denied.stderr, /sha must be/);
});

test('check, plan, and list subcommands use the trusted registry', () => {
  const directory = makeDirectory();
  try {
    const registryPath = writeRegistry(directory, activeRegistry([allocation()]));
    const check = runCli(['check', '--stack', 'issue-1234', '--actor', 'developer-one', '--registry', registryPath]);
    assert.equal(check.status, 0, check.stderr);

    const plan = runCli(['plan', '--stack', 'issue-1234', '--actor', 'developer-one', '--registry', registryPath, '--json']);
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.plan.composeProject, 'kordi-issue-1234');
    assert.equal(parsed.plan.lock, 'stack-issue-1234');
    assert.equal(parsed.plan.ports.api, 17787);

    const list = runCli(['list', '--registry', registryPath, '--json']);
    assert.equal(list.status, 0, list.stderr);
    const allocations = JSON.parse(list.stdout).allocations;
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].id, 'issue-1234');

    const denied = runCli(['check', '--stack', 'issue-1234', '--actor', 'developer-two', '--registry', registryPath]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /denied/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check fails closed when the registry is absent', () => {
  const directory = makeDirectory();
  try {
    const result = runCli([
      'check',
      '--stack',
      'issue-1234',
      '--actor',
      'developer-one',
      '--registry',
      join(directory, 'absent.json'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing or unreadable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('usage errors exit with status 2', () => {
  assert.equal(runCli(['unknown-subcommand']).status, 2);
  assert.equal(runCli(['check', '--stack', 'issue-1234', '--unknown']).status, 2);
  assert.equal(runCli(['validate-inputs', '--stack']).status, 2);
});
