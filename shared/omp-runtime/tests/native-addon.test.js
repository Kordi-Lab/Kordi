import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeAddon } from '../scripts/native-addon.mjs';

test('x64 packaging selects the baseline addon from the pinned variant-only layout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-omp-addon-'));
  try {
    writeFileSync(join(directory, 'pi_natives.linux-x64-modern.node'), 'synthetic');
    expect(() => resolveNativeAddon(directory, 'linux', 'x64')).toThrow('portable OMP native addon');
    const baseline = join(directory, 'pi_natives.linux-x64-baseline.node');
    writeFileSync(baseline, 'synthetic');
    expect(resolveNativeAddon(directory, 'linux', 'x64')).toBe(baseline);
    writeFileSync(join(directory, 'pi_natives.linux-x64.node'), 'synthetic');
    expect(resolveNativeAddon(directory, 'linux', 'x64')).toBe(baseline);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('arm64 packaging preserves the unsuffixed addon layout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kordi-omp-addon-'));
  try {
    const addon = join(directory, 'pi_natives.darwin-arm64.node');
    writeFileSync(addon, 'synthetic');
    expect(resolveNativeAddon(directory, 'darwin', 'arm64')).toBe(addon);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
