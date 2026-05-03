#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopCargoToml = path.join(repoRoot, 'app/desktop/src-tauri/Cargo.toml');
const forbiddenPackages = ['kordi-tui', 'clap', 'crossterm'];
const args = ['tree', '-p', 'kordi-desktop', '--no-default-features'];
const result = spawnSync('cargo', args, {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (result.error) {
  console.error(`Failed to run cargo ${args.join(' ')}: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
if (result.status !== 0) {
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

const matches = output
  .split('\n')
  .filter((line) => forbiddenPackages.some((name) => line.includes(`${name} v`)));

if (matches.length > 0) {
  console.error('Desktop dependency tree includes terminal/CLI-only packages:');
  for (const line of matches) {
    console.error(`  ${line}`);
  }
  console.error('\nExpected kordi-desktop to depend on kordi-cli without the default terminal UI feature set.');
  process.exit(1);
}

const manifest = readFileSync(desktopCargoToml, 'utf8');
const crateTypeLine = manifest.match(/^crate-type\s*=\s*\[(?<types>[^\]]*)\]/m);
if (crateTypeLine?.groups?.types?.includes('"staticlib"')) {
  console.error('Desktop crate still emits staticlib artifacts.');
  console.error('Expected app/desktop/src-tauri/Cargo.toml crate-type to omit "staticlib" for macOS desktop builds.');
  process.exit(1);
}

console.log('Desktop dependency surface check passed: no kordi-tui, clap, or crossterm in kordi-desktop tree, and no desktop staticlib crate type.');
