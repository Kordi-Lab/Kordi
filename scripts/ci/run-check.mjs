#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadInventory } from './select-checks.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const unavailableExitCode = 3;

const platform = process.env.KORDI_CHECK_PLATFORM || process.platform;

function probeCommand(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) {
    return `${command} is not available (${result.error.message})`;
  }
  if (result.status !== 0) {
    return `${command} ${args.join(' ')} exited with code ${result.status}`;
  }
  return null;
}

const probes = new Map([
  ['node', () => (process.version ? null : 'Node.js is required')],
  ['pnpm', () => probeCommand('pnpm', ['--version'])],
  ['cargo', () => probeCommand('cargo', ['--version'])],
  ['git', () => probeCommand('git', ['--version'])],
  [
    'xcode',
    () =>
      platform === 'darwin'
        ? probeCommand('xcodebuild', ['-version'])
        : 'Xcode requires macOS',
  ],
  [
    'xcodegen',
    () =>
      platform === 'darwin'
        ? probeCommand('xcodegen', ['--version'])
        : 'XcodeGen requires macOS',
  ],
  ['docker', () => probeCommand('docker', ['--version'])],
  [
    'postgres',
    () => {
      if (process.env.KORDI_MIGRATION_PG_BIN) {
        return null;
      }
      const docker = probeCommand('docker', ['--version']);
      return docker
        ? 'no pinned PostgreSQL: install Docker or run scripts/prepare-ci-postgres.sh and set KORDI_MIGRATION_PG_BIN'
        : null;
    },
  ],
  [
    'playwright-chromium',
    () => {
      const playwright = probeCommand('pnpm', [
        '--dir',
        'app/desktop',
        'exec',
        'playwright',
        '--version',
      ]);
      return playwright
        ? 'Playwright is unavailable; run pnpm install --frozen-lockfile and pnpm --dir app/desktop exec playwright install chromium'
        : null;
    },
  ],
]);

function checkAvailability(group) {
  if (group.runner.startsWith('macos') && platform !== 'darwin') {
    return `requires macOS (runner: ${group.runner})`;
  }
  for (const prerequisite of group.prerequisites) {
    const probe = probes.get(prerequisite);
    if (!probe) {
      return `unknown prerequisite: ${prerequisite}`;
    }
    const problem = probe();
    if (problem) {
      return `${prerequisite}: ${problem}`;
    }
  }
  return null;
}

function usage() {
  return [
    'Usage: node scripts/ci/run-check.mjs <group-id> [--dry-run]',
    '',
    'Runs the shared command for one check group from scripts/ci/check-inventory.json.',
    'Exits with code 3 when a platform prerequisite is unavailable.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((argument) => argument !== '--dry-run');
  if (positional.length !== 1 || positional[0].startsWith('-')) {
    console.error('run-check: expected exactly one group id');
    console.error(`run-check: available groups: ${listGroupIds()}`);
    return 1;
  }
  const groupId = positional[0];

  let inventory;
  try {
    inventory = loadInventory();
  } catch (error) {
    console.error(`run-check: ${error.message}`);
    return 1;
  }
  const group = inventory.groups.find((entry) => entry.id === groupId);
  if (!group) {
    console.error(`run-check: unknown check group "${groupId}"`);
    console.error(`run-check: available groups: ${inventory.groups.map((entry) => entry.id).join(', ')}`);
    return 1;
  }

  if (dryRun) {
    console.log(group.command);
    return 0;
  }

  const unavailable = checkAvailability(group);
  if (unavailable) {
    console.error(`run-check: ${groupId} is unavailable: ${unavailable}`);
    console.error(`run-check: ${groupId} was not executed and is not reported as passing.`);
    return unavailableExitCode;
  }

  const result = spawnSync(group.command, {
    shell: true,
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env,
  });
  if (result.error) {
    console.error(`run-check: failed to start ${groupId}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function listGroupIds() {
  try {
    return loadInventory()
      .groups.map((entry) => entry.id)
      .join(', ');
  } catch {
    return 'unavailable';
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  process.exitCode = main();
}
