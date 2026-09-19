#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_GROUP_IDS,
  buildGroupResults,
  createFullManifest,
  evaluateGate,
  formatGateReport,
  loadResultFiles,
  loadResultsFromDirectory,
  parseArgs,
  parseManifestText,
  validateManifest,
} from './ci/ci-results.mjs';

export {
  MANIFEST_VERSION,
  REQUIRED_GROUP_IDS,
  buildGroupResults,
  createFullManifest,
  evaluateGate,
  formatGateReport,
  loadResultFiles,
  loadResultsFromDirectory,
  mapJobResult,
  parseArgs,
  parseManifestText,
  validateManifest,
  validateResultShape,
} from './ci/ci-results.mjs';

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
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
