#!/usr/bin/env node
// Fails when a pinned Rust toolchain (a Docker `rust:<version>` builder image
// or a `rust-toolchain` file) is older than the highest `rust-version` declared
// by any package in the locked workspace dependency graph.
//
// CI installs the latest stable Rust, so a dependency bump that raises the
// minimum supported Rust version passes CI while every pinned Docker build of
// the workspace fails on a fresh host without cached images.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Docker images in this repository build Linux binaries for x86_64.
export const METADATA_PLATFORM = 'x86_64-unknown-linux-gnu';

// Files that pin Rust but do not build the root workspace from Cargo.lock.
export const EXEMPT_FILES = Object.freeze({
  'bridges/docker/Dockerfile.build':
    'standalone bridges workspace imported with the bridges subtree; it has no lockfile and is not used by any script or CI job',
  'bridges/docker/docker-compose.yml':
    'standalone bridges workspace imported with the bridges subtree; it has no lockfile and is not used by any script or CI job',
});

const CANDIDATE_FILE =
  /(?:^|\/)(?:Dockerfile[^/]*|[^/]+\.Dockerfile|Containerfile[^/]*|[^/]*compose[^/]*\.ya?ml|rust-toolchain(?:\.toml)?)$/;
const DOCKER_FROM = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i;
const COMPOSE_IMAGE = /^\s*image:\s*["']?([^"'\s#]+)/;
const RUST_IMAGE_TAG = /^(?:(?:docker\.io\/)?library\/)?rust:(\d+\.\d+(?:\.\d+)?)(?:[-@]|$)/;
const TOOLCHAIN_CHANNEL = /^\s*channel\s*=\s*["'](\d+\.\d+(?:\.\d+)?)["']/m;
const PLAIN_VERSION = /^\s*(\d+\.\d+(?:\.\d+)?)\s*$/;

export function isCandidateFile(file) {
  return CANDIDATE_FILE.test(file);
}

export function parseVersion(version) {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`invalid Rust version: ${version}`);
  }
  return [parts[0], parts[1], parts[2] ?? 0];
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

// Returns [{ file, line, version }] for every numerically pinned toolchain.
// Floating tags such as `rust:latest` or `channel = "stable"` are ignored.
export function findPinnedToolchains(file, text) {
  const base = path.posix.basename(file);
  if (base === 'rust-toolchain.toml' || base === 'rust-toolchain') {
    const match = text.match(TOOLCHAIN_CHANNEL) ?? (base === 'rust-toolchain' ? text.match(PLAIN_VERSION) : null);
    if (!match) {
      return [];
    }
    const line = text.slice(0, match.index).split('\n').length;
    return [{ file, line, version: match[1] }];
  }
  const pins = [];
  text.split('\n').forEach((content, index) => {
    const image = content.match(DOCKER_FROM)?.[1] ?? content.match(COMPOSE_IMAGE)?.[1];
    const version = image?.match(RUST_IMAGE_TAG)?.[1];
    if (version) {
      pins.push({ file, line: index + 1, version });
    }
  });
  return pins;
}

// Returns the highest `rust-version` among resolved packages and the packages
// that declare it.
export function requiredRustVersion(metadata) {
  const resolved = new Set((metadata.resolve?.nodes ?? []).map((node) => node.id));
  let version = null;
  let packages = [];
  for (const pkg of metadata.packages ?? []) {
    if (!pkg.rust_version || (resolved.size > 0 && !resolved.has(pkg.id))) {
      continue;
    }
    const order = version === null ? 1 : compareVersions(pkg.rust_version, version);
    if (order > 0) {
      version = pkg.rust_version;
      packages = [];
    }
    if (order >= 0) {
      packages.push(`${pkg.name}@${pkg.version}`);
    }
  }
  return { version, packages: packages.sort() };
}

export function findOutdatedPins(pins, required) {
  return pins.filter((pin) => !EXEMPT_FILES[pin.file] && compareVersions(pin.version, required) < 0);
}

function listRepositoryFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && isCandidateFile(file));
}

export function collectRepositoryPins() {
  return listRepositoryFiles().flatMap((file) =>
    findPinnedToolchains(file, readFileSync(path.join(repoRoot, file), 'utf8')),
  );
}

function loadMetadata() {
  const output = execFileSync(
    'cargo',
    ['metadata', '--locked', '--format-version', '1', '--filter-platform', METADATA_PLATFORM],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

function main() {
  const pins = collectRepositoryPins();
  if (pins.length === 0) {
    throw new Error('no pinned Rust toolchains were found; the file patterns may be stale');
  }
  const { version: required, packages } = requiredRustVersion(loadMetadata());
  if (!required) {
    throw new Error('cargo metadata reported no rust-version for any package');
  }
  const outdated = findOutdatedPins(pins, required);
  if (outdated.length > 0) {
    console.error(`Locked dependencies require Rust ${required} (${packages.join(', ')}).`);
    console.error('These pinned toolchains are older and cannot build the workspace:');
    for (const pin of outdated) {
      console.error(`  ${pin.file}:${pin.line} pins Rust ${pin.version}`);
    }
    console.error('Raise the pinned version, or hold back the dependency that raised the requirement.');
    process.exit(1);
  }
  const checked = pins.filter((pin) => !EXEMPT_FILES[pin.file]);
  console.log(`Pinned Rust toolchains satisfy the locked requirement of Rust ${required} (${checked.length} checked).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
