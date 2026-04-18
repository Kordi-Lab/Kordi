#!/usr/bin/env node

import { existsSync, chmodSync, createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BIN_DIR = join(ROOT, 'bin');

function getPackageJson() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
}

function getCliName() {
  const pkg = getPackageJson();
  const bin = pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin) : [];
  return bin[0] || pkg.name || 'bridges';
}

function getRepositoryUrl() {
  const pkg = getPackageJson();
  return pkg.repository?.url || 'https://github.com/shuyhere/Bridges.git';
}

/**
 * Detect whether the current Linux system uses musl libc.
 * @returns {boolean}
 */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const maps = readFileSync('/proc/self/maps', 'utf8');
    if (maps.includes('musl')) return true;
  } catch {
    // ignore
  }
  try {
    const result = spawnSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const output = (result.stdout || '') + (result.stderr || '');
    if (output.toLowerCase().includes('musl')) return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * Map process.platform + process.arch to the binary suffix.
 * @returns {string|null} Binary filename or null if unsupported
 */
function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;
  const cliName = getCliName();

  const platformMap = {
    'darwin-arm64': `${cliName}-darwin-arm64`,
    'darwin-x64': `${cliName}-darwin-x64`,
    'linux-x64': isMusl() ? `${cliName}-linux-musl-x64` : `${cliName}-linux-x64`,
    'linux-arm64': isMusl() ? `${cliName}-linux-musl-arm64` : `${cliName}-linux-arm64`,
    'win32-x64': `${cliName}-win32-x64.exe`,
  };

  return platformMap[`${platform}-${arch}`] || null;
}

/**
 * Read the package version from package.json.
 * @returns {string}
 */
function getVersion() {
  return getPackageJson().version;
}

/**
 * Download a file from a URL, following redirects.
 * @param {string} url
 * @param {string} dest
 * @returns {Promise<void>}
 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      httpsGet(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          try { unlinkSync(dest); } catch { /* ignore */ }
          reject(err);
        });
      }).on('error', (err) => {
        try { unlinkSync(dest); } catch { /* ignore */ }
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * For global npm installs, replace the npm-generated shim with a direct link
 * to the native binary for faster startup.
 * @param {string} binaryPath Absolute path to the native binary
 */
function optimizeGlobalInstall(binaryPath) {
  if (process.env.npm_config_global !== 'true') return;

  const npmBinDir = process.env.npm_config_prefix
    ? join(process.env.npm_config_prefix, 'bin')
    : null;

  if (!npmBinDir) return;

  if (process.platform === 'win32') {
    // Rewrite the .cmd shim to invoke the binary directly
    const cmdShim = join(npmBinDir, `${getCliName()}.cmd`);
    if (existsSync(cmdShim)) {
      try {
        writeFileSync(cmdShim, `@"${binaryPath}" %*\r\n`);
        console.log('  Optimized Windows .cmd shim for direct binary execution');
      } catch (err) {
        console.warn(`  Warning: could not optimize .cmd shim: ${err.message}`);
      }
    }
  } else {
    // Replace npm symlink with direct symlink to binary
    const shimPath = join(npmBinDir, getCliName());
    try {
      if (existsSync(shimPath)) {
        unlinkSync(shimPath);
      }
      symlinkSync(binaryPath, shimPath);
      console.log('  Replaced npm shim with direct binary symlink');
    } catch (err) {
      console.warn(`  Warning: could not replace symlink: ${err.message}`);
    }
  }
}

async function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.log(`${getCliName()}: unsupported platform ${process.platform}-${process.arch}`);
    console.log('You can build from source with: npm run build:native');
    return;
  }

  const binaryPath = join(BIN_DIR, binaryName);

  // Already installed
  if (existsSync(binaryPath)) {
    console.log(`${getCliName()}: native binary already present (${binaryName})`);
    optimizeGlobalInstall(binaryPath);
    return;
  }

  // Ensure bin/ directory exists
  mkdirSync(BIN_DIR, { recursive: true });

  const version = getVersion();
  const releaseBase = getRepositoryUrl().replace(/\.git$/, '');
  const url = `${releaseBase}/releases/download/v${version}/${binaryName}`;

  console.log(`${getCliName()}: downloading native binary for ${process.platform}-${process.arch}...`);
  console.log(`  ${url}`);

  try {
    await download(url, binaryPath);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }

    console.log(`${getCliName()}: installed ${binaryName}`);
    optimizeGlobalInstall(binaryPath);
  } catch (err) {
    console.warn(`${getCliName()}: failed to download pre-built binary: ${err.message}`);
    console.warn('');
    console.warn('You can build from source instead:');
    console.warn('');
    console.warn('  1. Install Rust: https://rustup.rs');
    console.warn('  2. Run: npm run build:native');
    console.warn('');
    // Don't fail the install — the user can build manually
  }
}

main().catch((err) => {
  console.error(`${getCliName()} postinstall error: ${err.message}`);
  // Non-zero exit would block npm install; just warn
});
