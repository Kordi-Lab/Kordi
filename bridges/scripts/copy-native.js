#!/usr/bin/env node

/**
 * Post-build script: copy the compiled Rust binary from Cargo's release output
 * to bin/bridges-{platform}-{arch}[.exe].
 */

import { copyFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePlatformBinaryName } from './platform-binary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BIN_DIR = join(ROOT, 'bin');

function getCliBinaryBaseName() {
  const cargoToml = readFileSync(join(ROOT, 'cli', 'Cargo.toml'), 'utf8');
  const match = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
  return match?.[1] || 'bridges';
}

function main() {
  const platform = process.platform;
  const arch = process.arch;
  const isWindows = platform === 'win32';

  const cliName = getCliBinaryBaseName();
  const sourceName = isWindows ? `${cliName}.exe` : cliName;
  const sourceCandidates = [
    join(ROOT, 'target', 'release', sourceName),
    join(ROOT, 'cli', 'target', 'release', sourceName),
  ];
  const sourcePath = sourceCandidates.find((candidate) => existsSync(candidate));

  if (!sourcePath) {
    console.error(`Build output not found. Checked: ${sourceCandidates.join(', ')}`);
    console.error('Run "cargo build --release --manifest-path cli/Cargo.toml" first.');
    process.exit(1);
  }

  const destName = resolvePlatformBinaryName({ cliName, platform, arch });
  if (!destName) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    process.exit(1);
  }

  const destPath = join(BIN_DIR, destName);

  // Ensure bin/ exists
  mkdirSync(BIN_DIR, { recursive: true });

  // Copy
  copyFileSync(sourcePath, destPath);

  // chmod +x on Unix
  if (!isWindows) {
    chmodSync(destPath, 0o755);
  }

  console.log(`Copied: ${sourcePath}`);
  console.log(`    To: ${destPath}`);
}

main();
