import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, '..');
const workspaceConfigPath = join(appRoot, 'kordi.workspace.json');
const binariesDir = join(appRoot, 'src-tauri', 'binaries');

export function resolveBuiltBinaryPath({ repoPath, configuredBinaryPath, cargoTargetDir }) {
  if (cargoTargetDir && configuredBinaryPath.includes('/target/release/')) {
    return join(cargoTargetDir, 'release', configuredBinaryPath.split('/target/release/').at(-1));
  }
  if (cargoTargetDir && configuredBinaryPath.startsWith('target/release/')) {
    return join(cargoTargetDir, 'release', configuredBinaryPath.slice('target/release/'.length));
  }
  return join(repoPath, configuredBinaryPath);
}

function detectTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }

  const result = spawnSync('rustc', ['-vV'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    console.error('[kordi] Failed to detect Rust target triple.');
    process.exit(result.status ?? 1);
  }

  const hostLine = result.stdout
    .split('\n')
    .find((line) => line.startsWith('host: '));

  if (!hostLine) {
    console.error('[kordi] Could not find host target triple from rustc -vV.');
    process.exit(1);
  }

  return hostLine.replace('host: ', '').trim();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureRepo(label, relativePath) {
  const repoPath = resolve(appRoot, relativePath);
  if (!existsSync(repoPath)) {
    console.error(`[kordi] Missing ${label} repo at ${repoPath}`);
    process.exit(1);
  }
  return repoPath;
}

function copyBinary(label, sourcePath, targetName) {
  if (!existsSync(sourcePath)) {
    console.error(`[kordi] Missing built binary for ${label}: ${sourcePath}`);
    process.exit(1);
  }

  mkdirSync(binariesDir, { recursive: true });
  const targetPath = join(binariesDir, targetName);
  copyFileSync(sourcePath, targetPath);
  console.log(`[kordi] Copied ${label} -> ${targetPath}`);
}

export function prepareSidecars() {
  const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'));
  const targetTriple = detectTargetTriple();

  const kordiRuntimeRepo = ensureRepo(
    'Kordi runtime',
    workspaceConfig.kordiRuntimePath ?? workspaceConfig.bbAgentPath,
  );
  const kordiRuntimeManifestPath =
    workspaceConfig.kordiRuntimeManifestPath
    ?? workspaceConfig.bbAgentManifestPath
    ?? 'crates/cli/Cargo.toml';
  const bridgesRepo = ensureRepo('Bridges', workspaceConfig.bridgesPath);
  const bridgesManifestPath =
    workspaceConfig.bridgesManifestPath ?? 'cli/Cargo.toml';

  console.log('[kordi] Building Kordi runtime sidecar...');
  run(
    'cargo',
    ['build', '--release', '--manifest-path', kordiRuntimeManifestPath],
    kordiRuntimeRepo,
  );

  console.log('[kordi] Building Bridges sidecar...');
  run(
    'cargo',
    ['build', '--release', '--manifest-path', bridgesManifestPath],
    bridgesRepo,
  );

  copyBinary(
    'Kordi runtime',
    resolveBuiltBinaryPath({
      repoPath: kordiRuntimeRepo,
      configuredBinaryPath: workspaceConfig.kordiRuntimeBinary ?? workspaceConfig.bbAgentBinary,
      cargoTargetDir: process.env.CARGO_TARGET_DIR ?? '',
    }),
    `kordi-${targetTriple}`,
  );

  copyBinary(
    'Bridges',
    resolveBuiltBinaryPath({
      repoPath: bridgesRepo,
      configuredBinaryPath: workspaceConfig.bridgesBinary,
      cargoTargetDir: process.env.CARGO_TARGET_DIR ?? '',
    }),
    `bridges-${targetTriple}`,
  );

  console.log('[kordi] Sidecars are ready for Tauri.');
}

if (process.argv[1] === __filename) {
  prepareSidecars();
}
