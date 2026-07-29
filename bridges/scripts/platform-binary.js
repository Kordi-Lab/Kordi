import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const SUPPORTED_PLATFORM_KEYS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);

export function detectMusl({
  platform = process.platform,
  readProcMaps = () => readFileSync('/proc/self/maps', 'utf8'),
  runLdd = () =>
    spawnSync('ldd', ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
} = {}) {
  if (platform !== 'linux') {
    return false;
  }

  try {
    if (readProcMaps().toLowerCase().includes('musl')) {
      return true;
    }
  } catch {
    // /proc is not available on every Linux environment.
  }

  try {
    const result = runLdd();
    return `${result.stdout || ''}${result.stderr || ''}`.toLowerCase().includes('musl');
  } catch {
    return false;
  }
}

export function resolvePlatformBinaryName({
  cliName,
  platform = process.platform,
  arch = process.arch,
  musl,
} = {}) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED_PLATFORM_KEYS.includes(key)) {
    return null;
  }

  const usesMusl = platform === 'linux' && (musl ?? detectMusl({ platform }));
  const libc = usesMusl ? '-musl' : '';
  const extension = platform === 'win32' ? '.exe' : '';

  return `${cliName}-${platform}${libc}-${arch}${extension}`;
}
