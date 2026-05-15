import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, '..');
const workspaceConfigPath = join(appRoot, 'kordi.workspace.json');
const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'));
const binariesDir = join(appRoot, 'src-tauri', 'binaries');

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

const targetTriple = detectTargetTriple();
const hostTriple = (() => {
  const result = spawnSync('rustc', ['-vV'], { cwd: appRoot, encoding: 'utf8', env: process.env });
  if (result.status !== 0) return targetTriple;
  const line = result.stdout.split('\n').find((l) => l.startsWith('host: '));
  return line ? line.replace('host: ', '').trim() : targetTriple;
})();
const crossArchBuild = targetTriple !== hostTriple;

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

const cargoTargetArgs = ['--target', targetTriple];

console.log(`[kordi] Building Kordi runtime sidecar for ${targetTriple}...`);
run(
  'cargo',
  ['build', '--release', ...cargoTargetArgs, '--manifest-path', kordiRuntimeManifestPath],
  kordiRuntimeRepo
);

console.log(`[kordi] Building Bridges sidecar for ${targetTriple}...`);
run(
  'cargo',
  ['build', '--release', ...cargoTargetArgs, '--manifest-path', bridgesManifestPath],
  bridgesRepo
);

function withTriple(relativePath, triple) {
  // Insert <triple> between the workspace target/ dir and release/. Handles
  // both `target/release/foo` and `../target/release/foo` shapes.
  return relativePath.replace(/(^|\/)target\/release\//, `$1target/${triple}/release/`);
}

const kordiRuntimeBinaryRel =
  workspaceConfig.kordiRuntimeBinary ?? workspaceConfig.bbAgentBinary;
const bridgesBinaryRel = workspaceConfig.bridgesBinary;

copyBinary(
  'Kordi runtime',
  join(kordiRuntimeRepo, withTriple(kordiRuntimeBinaryRel, targetTriple)),
  `kordi-${targetTriple}`
);

copyBinary(
  'Bridges',
  join(bridgesRepo, withTriple(bridgesBinaryRel, targetTriple)),
  `bridges-${targetTriple}`
);

if (crossArchBuild) {
  console.log(`[kordi] Cross-arch build detected (host ${hostTriple} -> target ${targetTriple}); sidecars built for ${targetTriple}.`);
}

console.log('[kordi] Sidecars are ready for Tauri.');
