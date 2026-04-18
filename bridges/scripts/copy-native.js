#!/usr/bin/env node

/**
 * Post-build script: copy the compiled Rust binary from Cargo's release output
 * to bin/bridges-{platform}-{arch}[.exe].
 */

import { copyFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BIN_DIR = join(ROOT, 'bin');

function getCliBinaryBaseName() {
  const cargoToml = readFileSync(join(ROOT, 'cli', 'Cargo.toml'), 'utf8');
  const match = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
  return match?.[1] || 'bridges';
}

/**
 * Detect whether the current Linux system uses musl libc.
 * @returns {boolean}
 */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const result = spawnSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const output = (result.stdout || '') + (result.stderr || '');
    if (output.toLowerCase().includes('musl')) return true;
  } catch {
    // ignore
  }
  return false;
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

  // Destination binary name
  let platformSuffix;
  if (platform === 'darwin') {
    platformSuffix = `darwin-${arch}`;
  } else if (platform === 'linux') {
    const libc = isMusl() ? 'musl' : '';
    platformSuffix = libc ? `linux-${libc}-${arch}` : `linux-${arch}`;
  } else if (platform === 'win32') {
    platformSuffix = `win32-${arch}`;
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  const destName = isWindows
    ? `${cliName}-${platformSuffix}.exe`
    : `${cliName}-${platformSuffix}`;
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
