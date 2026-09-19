#!/usr/bin/env node
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = 1;

export const REQUIRED_GROUP_IDS = Object.freeze([
  'frontend',
  'visual',
  'browser',
  'server',
  'migrations',
  'desktop',
  'ios',
  'hygiene',
]);

const FAILURE_CODES = new Map([
  ['failure', 'failed'],
  ['timeout', 'timed-out'],
  ['timed_out', 'timed-out'],
  ['cancelled', 'cancelled'],
  ['cancellation', 'cancelled'],
  ['skipped', 'unexpected-skip'],
  ['missing', 'missing-result'],
]);

const VALUE_OPTIONS = new Set([
  'manifest',
  'results-dir',
  'expected-revision',
  'group',
  'base',
  'head',
  'mode',
  'reason',
  'groups',
  'fallback',
  'out',
  'sha',
  'run-id',
]);

const REPEATABLE_OPTIONS = new Set(['results', 'result']);

const FLAG_OPTIONS = new Set(['json', 'fail-on-invalid', 'summary', 'help']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function parseManifestText(text) {
  try {
    return { manifest: JSON.parse(text), errors: [] };
  } catch (error) {
    return { manifest: undefined, errors: [`manifest is not valid JSON: ${error.message}`] };
  }
}

export function validateManifest(manifest, {
  expectedRevision,
  requiredGroupIds = REQUIRED_GROUP_IDS,
} = {}) {
  if (!isPlainObject(manifest)) return ['manifest must be a JSON object'];

  const errors = [];
  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`manifest version must be ${MANIFEST_VERSION}`);
  }
  for (const field of ['base', 'head', 'mode', 'generatedBy']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`manifest ${field} must be a non-empty string`);
    }
  }
  if (typeof manifest.fallback !== 'boolean') {
    errors.push('manifest fallback must be a boolean');
  }
  if (expectedRevision && manifest.head !== expectedRevision) {
    errors.push(`manifest head ${JSON.stringify(manifest.head)} does not match expected revision ${expectedRevision}`);
  }
  if (!Array.isArray(manifest.groups)) {
    errors.push('manifest groups must be an array');
    return errors;
  }
  if (manifest.groups.length === 0) {
    errors.push('manifest groups must not be empty');
  }

  const seen = new Set();
  for (const group of manifest.groups) {
    if (!isPlainObject(group)) {
      errors.push('each manifest group must be an object');
      continue;
    }
    if (typeof group.id !== 'string' || group.id.trim() === '') {
      errors.push('each manifest group must have a non-empty id');
      continue;
    }
    if (seen.has(group.id)) {
      errors.push(`manifest contains duplicate group ${group.id}`);
      continue;
    }
    seen.add(group.id);
    if (typeof group.applicable !== 'boolean') {
      errors.push(`manifest group ${group.id} must set applicable to a boolean`);
    } else if (group.applicable === false && (typeof group.reason !== 'string' || group.reason.trim() === '')) {
      errors.push(`manifest group ${group.id} must include a reason when it is not applicable`);
    }
  }

  for (const id of requiredGroupIds) {
    if (!seen.has(id)) errors.push(`manifest is missing required group ${id}`);
  }

  return errors;
}

export function validateResultShape(result) {
  if (!isPlainObject(result)) return ['completion result must be an object'];

  const errors = [];
  for (const field of ['group', 'outcome', 'sha']) {
    if (typeof result[field] !== 'string' || result[field].trim() === '') {
      errors.push(`completion result ${field} must be a non-empty string`);
    }
  }
  if (typeof result.applicable !== 'boolean') {
    errors.push('completion result applicable must be a boolean');
  }
  if (typeof result.executed !== 'boolean') {
    errors.push('completion result executed must be a boolean');
  }
  if (typeof result.runId !== 'string' && typeof result.runId !== 'number') {
    errors.push('completion result runId must be a string or number');
  }
  return errors;
}

export function mapJobResult(jobResult, applicable) {
  const normalized = typeof jobResult === 'string' ? jobResult.trim().toLowerCase() : '';
  switch (normalized) {
    case 'success':
      return { executed: true, outcome: 'success' };
    case 'failure':
      return { executed: true, outcome: 'failure' };
    case 'cancelled':
      return { executed: true, outcome: 'cancelled' };
    case 'timeout':
    case 'timed_out':
      return { executed: true, outcome: 'timeout' };
    case 'skipped':
      return applicable
        ? { executed: false, outcome: 'skipped' }
        : { executed: false, outcome: 'not_applicable' };
    default:
      return { executed: false, outcome: 'missing' };
  }
}

export function buildGroupResults({ manifest, jobResults, sha, runId }) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.groups)) {
    throw new Error('manifest groups are required to build completion results');
  }

  const groups = new Map(manifest.groups.map((group) => [group.id, group]));
  return jobResults.map(({ group, jobResult }) => {
    const entry = groups.get(group);
    if (!entry) throw new Error(`manifest does not contain group ${group}`);
    const applicable = entry.applicable === true;
    const { executed, outcome } = mapJobResult(jobResult, applicable);
    return { group, applicable, executed, outcome, sha, runId: String(runId) };
  });
}

export function evaluateGate({
  manifest,
  results = [],
  expectedRevision,
  requiredGroupIds = REQUIRED_GROUP_IDS,
  manifestErrors = [],
  resultErrors = [],
}) {
  const report = {
    passed: false,
    expectedRevision: expectedRevision ?? null,
    baseRevision: isPlainObject(manifest) && typeof manifest.base === 'string' ? manifest.base : null,
    mode: isPlainObject(manifest) && typeof manifest.mode === 'string' ? manifest.mode : null,
    fallback: isPlainObject(manifest) && manifest.fallback === true,
    manifestErrors: [...manifestErrors],
    groups: [],
    failures: [],
    warnings: resultErrors.map((message) => ({ group: null, code: 'invalid-result', detail: message })),
  };

  if (report.manifestErrors.length === 0) {
    report.manifestErrors = validateManifest(manifest, { expectedRevision, requiredGroupIds });
  }
  if (report.manifestErrors.length > 0) {
    for (const detail of report.manifestErrors) {
      report.failures.push({ group: null, code: 'invalid-manifest', detail });
    }
    return report;
  }
  if (report.fallback) {
    report.warnings.push({ group: null, code: 'fallback-coverage', detail: 'manifest requests conservative full-suite coverage' });
  }

  const byGroup = new Map();
  const malformedGroups = new Set();
  results.forEach((result, index) => {
    const shapeErrors = validateResultShape(result);
    if (shapeErrors.length > 0) {
      const group = isPlainObject(result) && typeof result.group === 'string' ? result.group : null;
      if (group) malformedGroups.add(group);
      for (const detail of shapeErrors) {
        report.failures.push({ group, code: 'malformed-result', detail: `${detail} (result ${index})` });
      }
      return;
    }
    if (byGroup.has(result.group)) {
      report.failures.push({ group: result.group, code: 'duplicate-result', detail: 'more than one completion result was reported' });
      return;
    }
    byGroup.set(result.group, result);
  });

  const manifestGroups = new Set(manifest.groups.map((group) => group.id));
  for (const result of byGroup.values()) {
    if (!manifestGroups.has(result.group)) {
      report.warnings.push({ group: result.group, code: 'unexpected-result', detail: 'completion result has no matching manifest group' });
    }
  }

  for (const group of manifest.groups) {
    const entry = {
      id: group.id,
      applicable: group.applicable === true,
      status: 'failed',
      outcome: null,
      reason: typeof group.reason === 'string' && group.reason.trim() !== '' ? group.reason : null,
      detail: null,
    };
    report.groups.push(entry);

    if (malformedGroups.has(group.id)) {
      entry.detail = 'completion result is malformed';
      continue;
    }
    const result = byGroup.get(group.id);
    if (!result) {
      entry.detail = 'no completion result was reported';
      report.failures.push({ group: group.id, code: 'missing-result', detail: entry.detail });
      continue;
    }
    entry.outcome = result.outcome;
    if (result.sha !== expectedRevision) {
      entry.detail = `completion result reports revision ${result.sha}`;
      report.failures.push({ group: group.id, code: 'stale-revision', detail: entry.detail });
      continue;
    }
    if (result.applicable !== entry.applicable) {
      entry.detail = 'completion result applicability disagrees with the manifest';
      report.failures.push({ group: group.id, code: 'inconsistent-applicability', detail: entry.detail });
      continue;
    }
    if (entry.applicable) {
      if (result.executed === true && result.outcome === 'success') {
        entry.status = 'passed';
        entry.detail = 'required check passed';
        continue;
      }
      entry.detail = `required check outcome was ${result.outcome}`;
      report.failures.push({
        group: group.id,
        code: FAILURE_CODES.get(result.outcome) ?? 'invalid-result',
        detail: entry.detail,
      });
      continue;
    }
    if (result.executed === false && result.outcome === 'not_applicable') {
      entry.status = 'not-applicable';
      entry.detail = `not applicable: ${entry.reason ?? 'no reason recorded'}`;
      continue;
    }
    entry.detail = `not-applicable group reported ${result.outcome}`;
    report.failures.push({ group: group.id, code: 'invalid-result', detail: entry.detail });
  }

  report.passed = report.failures.length === 0;
  return report;
}

export function formatGateReport(report) {
  const lines = [
    `CI required: ${report.passed ? 'PASS' : 'FAIL'} `
    + `(expected revision ${report.expectedRevision ?? 'unknown'}, mode ${report.mode ?? 'unknown'})`,
  ];
  for (const group of report.groups) {
    if (group.status === 'passed') lines.push(`- ${group.id}: passed`);
    else if (group.status === 'not-applicable') lines.push(`- ${group.id}: not applicable - ${group.reason ?? 'no reason recorded'}`);
    else lines.push(`- ${group.id}: FAILED - ${group.detail ?? 'unknown failure'}`);
  }
  for (const failure of report.failures) {
    lines.push(`failure [${failure.code}]${failure.group ? ` ${failure.group}` : ''}: ${failure.detail}`);
  }
  for (const warning of report.warnings) {
    lines.push(`warning [${warning.code}]${warning.group ? ` ${warning.group}` : ''}: ${warning.detail}`);
  }
  return lines.join('\n');
}

export function createFullManifest({
  base,
  head,
  mode = 'fallback',
  fallback = true,
  reason = 'conservative full-suite coverage',
  groupIds = REQUIRED_GROUP_IDS,
  generatedBy = 'scripts/check-ci-results.mjs',
} = {}) {
  if (typeof head !== 'string' || head.trim() === '') throw new Error('head revision is required');

  const missing = REQUIRED_GROUP_IDS.filter((id) => !groupIds.includes(id));
  if (missing.length > 0) throw new Error(`full manifest is missing required groups: ${missing.join(', ')}`);

  return {
    version: MANIFEST_VERSION,
    base: typeof base === 'string' && base.trim() !== '' ? base : head,
    head,
    mode,
    fallback,
    generatedBy,
    groups: [...new Set(groupIds)].map((id) => ({ id, applicable: true, reason })),
  };
}

export async function loadResultFiles(files) {
  const results = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed)) results.push(...parsed);
    else results.push(parsed);
  }
  return results;
}

export async function loadResultsFromDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  return loadResultFiles(files);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, results: [], result: [] };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') continue;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);

    const equalsIndex = token.indexOf('=');
    const name = equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex);
    let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

    if (FLAG_OPTIONS.has(name)) {
      if (value !== undefined) throw new Error(`Option --${name} does not take a value`);
      options[toCamelCase(name)] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name) && !REPEATABLE_OPTIONS.has(name)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (value === undefined) {
      value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
      index += 1;
    }
    if (REPEATABLE_OPTIONS.has(name)) options[toCamelCase(name)].push(value);
    else options[toCamelCase(name)] = value;
  }

  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value === '') throw new Error(`--${toKebabCase(name)} is required`);
  return value;
}

async function runEvaluate(options) {
  const manifestPath = requireOption(options, 'manifest');
  const expectedRevision = requireOption(options, 'expectedRevision');
  const parsed = parseManifestText(await readFile(manifestPath, 'utf8'));
  const results = [
    ...await loadResultFiles(options.results),
    ...options.resultsDir ? await loadResultsFromDirectory(options.resultsDir) : [],
  ];
  const report = evaluateGate({
    manifest: parsed.manifest,
    manifestErrors: parsed.errors,
    results,
    expectedRevision,
  });

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatGateReport(report));
  if (!report.passed) process.exitCode = 1;
}

async function runCheckManifest(options) {
  const manifestPath = requireOption(options, 'manifest');
  const expectedRevision = requireOption(options, 'expectedRevision');
  const parsed = parseManifestText(await readFile(manifestPath, 'utf8'));
  const errors = parsed.errors.length > 0
    ? parsed.errors
    : validateManifest(parsed.manifest, { expectedRevision });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`manifest ok for ${expectedRevision}`);
}

async function runApplicable(options) {
  const manifestPath = requireOption(options, 'manifest');
  const group = requireOption(options, 'group');
  const parsed = parseManifestText(await readFile(manifestPath, 'utf8'));
  const errors = parsed.errors.length > 0 ? parsed.errors : validateManifest(parsed.manifest);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const entry = parsed.manifest.groups.find((candidate) => candidate.id === group);
  if (!entry) {
    console.error(`manifest does not contain group ${group}`);
    process.exitCode = 1;
    return;
  }
  console.log(String(entry.applicable === true));
}

async function runFullManifest(options) {
  const head = requireOption(options, 'head');
  const groupIds = options.groups
    ? options.groups.split(',').map((value) => value.trim()).filter(Boolean)
    : REQUIRED_GROUP_IDS;
  const manifest = createFullManifest({
    base: options.base,
    head,
    mode: options.mode ?? 'fallback',
    fallback: options.fallback === undefined ? true : options.fallback !== 'false',
    reason: options.reason,
    groupIds,
  });
  const out = requireOption(options, 'out');
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote full manifest with ${manifest.groups.length} groups to ${out}`);
}

async function runEmit(options) {
  const manifestPath = requireOption(options, 'manifest');
  const sha = options.sha ?? process.env.GITHUB_SHA;
  const runId = options.runId ?? process.env.GITHUB_RUN_ID ?? '0';
  if (!sha) throw new Error('--sha or GITHUB_SHA is required');
  if (options.result.length === 0) throw new Error('at least one --result <group>=<jobResult> is required');

  const parsed = parseManifestText(await readFile(manifestPath, 'utf8'));
  const errors = parsed.errors.length > 0
    ? parsed.errors
    : validateManifest(parsed.manifest, { expectedRevision: sha });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  const jobResults = options.result.map((spec) => {
    const separator = spec.indexOf('=');
    if (separator === -1) throw new Error(`--result must be <group>=<jobResult>: ${spec}`);
    return { group: spec.slice(0, separator), jobResult: spec.slice(separator + 1) };
  });
  const results = buildGroupResults({ manifest: parsed.manifest, jobResults, sha, runId });
  const serialized = `${JSON.stringify(results)}\n`;

  if (options.out) await writeFile(options.out, serialized);
  else process.stdout.write(serialized);

  if (options.summary && process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((result) => `| ${result.group} | ${result.outcome} | ${result.executed ? 'yes' : 'no'} |`)
      .join('\n');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Check group results\n\n| Group | Outcome | Executed |\n| --- | --- | --- |\n${rows}\n`,
    );
  }

  const invalid = results.filter((result) => (
    result.outcome !== 'success' && result.outcome !== 'not_applicable'
  ));
  for (const result of invalid) {
    console.error(`${result.group}: ${result.outcome}`);
  }
  if (invalid.length > 0 && options.failOnInvalid) process.exitCode = 1;
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-ci-results.mjs evaluate --manifest <path> --expected-revision <sha> [--results <path> ...] [--results-dir <dir>] [--json]
  node scripts/check-ci-results.mjs check-manifest --manifest <path> --expected-revision <sha>
  node scripts/check-ci-results.mjs applicable --manifest <path> --group <id>
  node scripts/check-ci-results.mjs full-manifest --head <sha> [--base <sha>] [--mode <mode>] [--reason <text>] [--groups <id,id>] [--fallback <true|false>] --out <path>
  node scripts/check-ci-results.mjs emit --manifest <path> --result <group>=<jobResult> ... [--sha <sha>] [--run-id <id>] [--out <path>] [--summary] [--fail-on-invalid]

The merge gate passes only when every applicable manifest group reports a
successful completion result for the expected revision, or reports an explicit
not-applicable decision with a reason. Missing, stale, malformed, cancelled,
timed-out, failed, or unexpectedly skipped results fail the gate.`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.command || options.help || options.command === 'help') {
    printHelp();
    return;
  }
  switch (options.command) {
    case 'evaluate':
      await runEvaluate(options);
      return;
    case 'check-manifest':
      await runCheckManifest(options);
      return;
    case 'applicable':
      await runApplicable(options);
      return;
    case 'full-manifest':
      await runFullManifest(options);
      return;
    case 'emit':
      await runEmit(options);
      return;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
