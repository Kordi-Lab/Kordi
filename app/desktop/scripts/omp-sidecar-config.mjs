import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function hostTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const triple = result.stdout?.match(/^host: (.+)$/m)?.[1];
  if (result.status !== 0 || !triple) throw new Error('Rust host target triple is required for OMP sidecars.');
  return triple;
}

export function ompExternalBins(targetTriple, platform = process.platform, arch = process.arch) {
  // The pinned native addon is validated for macOS/Linux. Windows keeps the
  // legacy Rust sidecar until OMP's addon placement and worker lifecycle are tested there.
  if (platform === 'win32') return ['binaries/kordi'];
  const expectedArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const expectedOs = platform === 'darwin' ? 'apple-darwin' : 'unknown-linux';
  if (!targetTriple.startsWith(`${expectedArch}-`) || !targetTriple.includes(expectedOs)) {
    throw new Error('OMP sidecar target must match the build host and installed native addon.');
  }
  return [
    'binaries/kordi',
    'binaries/kordi-omp',
    `binaries/pi_natives.${platform}-${arch}.node`,
  ];
}

export function writeOmpTauriOverlay(tauriDir, targetTriple) {
  const overlayDir = join(tauriDir, '.tauri-dev');
  mkdirSync(overlayDir, { recursive: true });
  const path = join(overlayDir, 'omp-sidecars.json');
  writeFileSync(path, `${JSON.stringify({ bundle: { externalBin: ompExternalBins(targetTriple) } }, null, 2)}\n`);
  return path;
}
