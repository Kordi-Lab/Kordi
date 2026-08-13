#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.dirname(SCRIPT_DIR);
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

const TEXT_RULES = [
  {
    id: 'private-key',
    description: 'private key material',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    id: 'credential-token',
    description: 'credential-shaped token',
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}/,
  },
  {
    id: 'credential-url',
    description: 'URL containing an embedded password',
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/(?!\[)[^\s/:]+:(?!<|\$\(|\$\{|\$[A-Z_]|\*{3}|unused@|secret-password@)[^\s/@]+@/i,
  },
  {
    id: 'personal-mailbox',
    description: 'personal email address',
    pattern: /[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163)\.com/i,
  },
  {
    id: 'local-home-path',
    description: 'developer home-directory path',
    pattern: /(?:\/Users\/(?!example(?:[\/\s<"'`]|$)|alice(?:[\/\s<"'`]|$)|owner(?:[\/\s<"'`]|$)|you(?:[\/\s<"'`]|$)|kordi-ci(?:[\/\s<"'`]|$)|\.\.\.(?:[\/\s<"'`]|$)|\*(?:[\/\s<"'`]|$)|\$\{RUNNER_ACCOUNT\}(?:[\/\s<"'`]|$))[^/\s<"'`]+|[A-Z]:\\Users\\(?!example(?:[\\\s<"'`]|$)|runner(?:[\\\s<"'`]|$)|user(?:[\\\s<"'`]|$))[^\\\s<"'`]+)/i,
  },
  {
    id: 'production-instance',
    description: 'concrete production instance identifier',
    pattern: /\bkordi-product-app-\d+\b/i,
  },
];

const FORBIDDEN_DATA_EXTENSION = /\.(?:db|db-(?:wal|shm|journal)|sqlite|sqlite-(?:wal|shm|journal)|sqlite3|sqlite3-(?:wal|shm|journal)|jsonl|ndjson|dump|bak|backup|parquet|avro|csv|tsv|pem|key|p8|p12|pfx|jks|keystore)$/i;
const FORBIDDEN_ARCHIVE_OR_DOCUMENT = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|pdf|docx?|xlsx?|pptx?)$/i;
const FORBIDDEN_RECORDED_MEDIA = /\.(?:mp3|m4a|aac|wav|ogg|flac|mp4|mov|m4v|webm)$/i;
const EXPORT_NAME = /(?:^|[-_.])(?:session|account|message|conversation|chat|transcript)[-_.]?(?:export|dump|backup)(?:[-_.]|$)|(?:^|[-_.])(?:export|dump|backup)[-_.]?(?:session|account|message|conversation|chat|transcript)(?:[-_.]|$)/i;
const LOCAL_AUTH_NAME = /(?:^|\/)(?:auth|credentials?|tokens?|cookies?)\.json$/i;
const ENV_FILE = /(?:^|\/)\.env(?:\..+)?$/i;
const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
const APPROVED_RASTER_PATH = /^(?:\.github\/assets\/|agent\/assets\/|app\/desktop\/public\/|app\/desktop\/src\/assets\/|app\/desktop\/src-tauri\/icons\/|app\/desktop\/tests\/visual\/__screenshots__\/|app\/ios\/Kordi\/Resources\/Assets\.xcassets\/)/;
const TRANSCRIPT_SHAPED_JSON = /"messages"\s*:\s*\[[\s\S]{0,200000}"role"\s*:\s*"(?:user|assistant)"/i;

function runGit(repositoryRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

function normalizeRepositoryPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function isExamplePath(repositoryPath) {
  return /(?:^|[._-])(?:example|sample|template)(?:[._-]|$)/i.test(path.basename(repositoryPath));
}

export function inspectRepositoryPath(repositoryPath) {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const findings = [];

  if (FORBIDDEN_DATA_EXTENSION.test(normalized)) {
    findings.push({ rule: 'private-data-file', description: 'database, transcript export, backup, or credential file' });
  }
  if (FORBIDDEN_ARCHIVE_OR_DOCUMENT.test(normalized)) {
    findings.push({ rule: 'unreviewed-binary-document', description: 'archive or binary office document' });
  }
  if (FORBIDDEN_RECORDED_MEDIA.test(normalized)) {
    findings.push({ rule: 'unreviewed-recorded-media', description: 'audio or video recording' });
  }
  if (EXPORT_NAME.test(path.basename(normalized))) {
    findings.push({ rule: 'private-data-export', description: 'account or conversation export filename' });
  }
  if (LOCAL_AUTH_NAME.test(normalized) && !isExamplePath(normalized)) {
    findings.push({ rule: 'local-auth-store', description: 'local authentication or credential store' });
  }
  if (ENV_FILE.test(normalized) && !isExamplePath(normalized)) {
    findings.push({ rule: 'environment-file', description: 'non-example environment file' });
  }
  if (normalized === 'deploy/dev/operator-github-allowlist.txt') {
    findings.push({ rule: 'operator-identity-file', description: 'local operator authorization list' });
  }
  if (RASTER_IMAGE.test(normalized) && !APPROVED_RASTER_PATH.test(normalized)) {
    findings.push({ rule: 'unreviewed-user-capture', description: 'image outside an approved product-asset or synthetic-baseline path' });
  }

  return findings;
}

function looksBinary(buffer) {
  const probeLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function normalizedDenylist(denylist) {
  const values = Array.isArray(denylist)
    ? denylist
    : String(denylist ?? '').split(/\r?\n/);
  return values.map((value) => value.trim()).filter(Boolean);
}

export function inspectText(contents, options = {}) {
  const findings = [];
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(contents)) {
      findings.push({ rule: rule.id, description: rule.description });
    }
  }

  const folded = contents.toLocaleLowerCase('en-US');
  for (const deniedValue of normalizedDenylist(options.denylist)) {
    if (folded.includes(deniedValue.toLocaleLowerCase('en-US'))) {
      findings.push({ rule: 'private-denylist', description: 'organization-private identity or infrastructure term' });
      break;
    }
  }
  return findings;
}

function inspectBlob(repositoryPath, buffer, options = {}) {
  const findings = inspectRepositoryPath(repositoryPath);
  findings.push(...inspectText(repositoryPath, options));
  if (
    repositoryPath !== 'scripts/privacy-guard.test.mjs'
    && repositoryPath !== 'scripts/repository-privacy-guard.mjs'
    && !looksBinary(buffer)
  ) {
    if (buffer.length > MAX_TEXT_BYTES) {
      findings.push({
        rule: 'oversized-text-object',
        description: 'text object is too large for privacy review',
      });
    } else {
      const contents = buffer.toString('utf8');
      findings.push(...inspectText(contents, options));
      if (/\.json$/i.test(repositoryPath) && TRANSCRIPT_SHAPED_JSON.test(contents)) {
        findings.push({
          rule: 'transcript-shaped-json',
          description: 'JSON resembles a serialized chat transcript',
        });
      }
    }
  }
  return findings;
}

function appendFindings(target, source, repositoryPath, origin) {
  for (const finding of source) {
    target.push({ ...finding, path: repositoryPath, origin });
  }
}

function workingTreePaths(repositoryRoot) {
  const output = runGit(repositoryRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return [...new Set(splitNull(output))].sort();
}

export function scanWorkingTree(repositoryRoot = DEFAULT_REPOSITORY_ROOT, options = {}) {
  const findings = [];
  for (const repositoryPath of workingTreePaths(repositoryRoot)) {
    const absolutePath = path.join(repositoryRoot, repositoryPath);
    let buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      continue;
    }
    appendFindings(
      findings,
      inspectBlob(repositoryPath, buffer, options),
      repositoryPath,
      'working-tree',
    );
  }
  return findings;
}

function comparisonRange(repositoryRoot, comparison) {
  if (!comparison || comparison === 'HEAD') {
    try {
      runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^']);
      return 'HEAD^..HEAD';
    } catch {
      return 'HEAD';
    }
  }

  if (comparison.includes('...')) {
    const [base, head] = comparison.split('...', 2);
    const mergeBase = runGit(repositoryRoot, ['merge-base', base, head]).trim();
    return `${mergeBase}..${head}`;
  }
  return comparison;
}

function changedPathsAtCommit(repositoryRoot, commit) {
  const output = runGit(repositoryRoot, [
    'diff-tree',
    '--root',
    '-r',
    '-m',
    '--no-commit-id',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
    commit,
  ]);
  return [...new Set(splitNull(output))].sort();
}

function commitMetadata(repositoryRoot, commit) {
  return runGit(repositoryRoot, ['show', '-s', '--format=%B%n%an%n%ae%n%cn%n%ce', commit]);
}

export function scanComparison(repositoryRoot = DEFAULT_REPOSITORY_ROOT, comparison = 'HEAD', options = {}) {
  const range = comparisonRange(repositoryRoot, comparison);
  const commits = runGit(repositoryRoot, ['rev-list', '--reverse', range]).trim().split(/\r?\n/).filter(Boolean);
  const findings = [];

  if (commits.length > 500) {
    return [{
      rule: 'comparison-too-large',
      description: 'privacy scan comparison contains more than 500 commits',
      path: '(commit range)',
      origin: range,
    }];
  }

  for (const commit of commits) {
    appendFindings(
      findings,
      inspectText(commitMetadata(repositoryRoot, commit), options),
      '(commit metadata)',
      commit,
    );
    for (const repositoryPath of changedPathsAtCommit(repositoryRoot, commit)) {
      let buffer;
      try {
        buffer = runGit(repositoryRoot, ['show', `${commit}:${repositoryPath}`], { encoding: 'buffer' });
      } catch {
        continue;
      }
      appendFindings(
        findings,
        inspectBlob(repositoryPath, buffer, options),
        repositoryPath,
        commit,
      );
    }
  }
  return findings;
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}\0${finding.path}\0${finding.origin}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function scanRepository(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const denylist = options.denylist ?? process.env.KORDI_PRIVACY_DENYLIST ?? '';
  const findings = [];
  if (options.includeWorkingTree !== false) {
    findings.push(...scanWorkingTree(repositoryRoot, { denylist }));
  }
  if (options.comparison) {
    findings.push(...scanComparison(repositoryRoot, options.comparison, { denylist }));
  }
  return deduplicateFindings(findings);
}

function parseArguments(argv) {
  const args = argv.filter((argument) => argument !== '--');
  const comparisonIndex = args.indexOf('--comparison');
  return {
    comparison: comparisonIndex >= 0 ? args[comparisonIndex + 1] : undefined,
  };
}

function redactedPath(repositoryPath, denylist) {
  if (inspectText(repositoryPath, { denylist }).length === 0) {
    return repositoryPath;
  }
  const digest = createHash('sha256').update(repositoryPath).digest('hex').slice(0, 12);
  return `(redacted path sha256:${digest})`;
}

export function formatFinding(finding, options = {}) {
  const origin = finding.origin === 'working-tree'
    ? 'working tree'
    : `commit ${finding.origin.slice(0, 12)}`;
  return `${redactedPath(finding.path, options.denylist)} [${finding.rule}; ${origin}]`;
}

function main() {
  const { comparison } = parseArguments(process.argv.slice(2));
  const denylist = process.env.KORDI_PRIVACY_DENYLIST ?? '';
  const findings = scanRepository({ comparison, denylist });
  if (findings.length === 0) {
    const scope = comparison ? ` and new objects in ${comparison}` : '';
    console.log(`[kordi] Repository privacy guard passed: current files${scope} are clean.`);
    return;
  }

  console.error('[kordi] Repository privacy guard blocked private or user-derived data.');
  console.error('Only paths and rule identifiers are shown; file contents are intentionally omitted:');
  for (const finding of findings) {
    console.error(`  - ${formatFinding(finding, { denylist })}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
