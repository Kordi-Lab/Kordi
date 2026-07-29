#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_PLATFORM_KEYS,
  resolvePlatformBinaryName,
} from '../scripts/platform-binary.js';

function getCliName() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const bin = pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin) : [];
    return bin[0] || pkg.name || 'bridges';
  } catch {
    return 'bridges';
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Map process.platform + process.arch to the binary suffix.
 * @returns {string} Binary filename for this platform
 */
function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;
  const name = resolvePlatformBinaryName({ cliName: getCliName(), platform, arch });

  if (!name) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    console.error(`Supported platforms: ${SUPPORTED_PLATFORM_KEYS.join(', ')}`);
    process.exit(1);
  }

  return name;
}

function main() {
  const binaryName = getBinaryName();
  const binaryPath = join(__dirname, binaryName);

  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    console.error('');
    console.error('The native binary for your platform has not been installed.');
    console.error('Try one of the following:');
    console.error('');
    console.error('  npm run build:native    # Build from source (requires Rust)');
    console.error('  node scripts/postinstall.js  # Download pre-built binary');
    console.error('');
    process.exit(1);
  }

  // Ensure binary is executable on Unix
  if (process.platform !== 'win32') {
    try {
      chmodSync(binaryPath, 0o755);
    } catch {
      // May fail if we don't own the file; that's okay if it's already executable
    }
  }

  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    if (result.error.code === 'EACCES') {
      console.error(`Permission denied: ${binaryPath}`);
      console.error('Try: chmod +x ' + binaryPath);
    } else {
      console.error(`Failed to execute binary: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

main();
