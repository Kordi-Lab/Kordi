import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('compiled OMP worker boots with the packaged version-matched native addon', () => {
  const triple = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.match(/^host: (.+)$/m)?.[1];
  if (!triple) throw new Error('Rust host target is required for the packaging smoke test.');
  const outputDir = mkdtempSync(join(tmpdir(), 'kordi-omp-package-'));
  const binary = `kordi-omp-${triple}${process.platform === 'win32' ? '.exe' : ''}`;
  try {
    const build = spawnSync('node', ['scripts/build-standalone.mjs', outputDir, triple], {
      cwd: import.meta.dir + '/..', encoding: 'utf8', timeout: 120_000,
    });
    if (build.status !== 0) throw new Error(`OMP standalone build failed: ${build.stderr || build.stdout}`);
    expect(build.status).toBe(0);
    const addon = `pi_natives.${process.platform}-${process.arch}.node`;
    expect(existsSync(join(outputDir, addon))).toBe(true);
    expect(existsSync(join(outputDir, `${addon}-${triple}`))).toBe(true);
    const boot = spawnSync(join(outputDir, binary), [], {
      input: '', encoding: 'utf8', timeout: 15_000,
    });
    if (boot.status !== 0) throw new Error(`OMP worker startup failed: ${boot.stderr || boot.stdout}`);
    expect(boot.status).toBe(0);
    expect(boot.stdout.trim()).toBe('{"schemaVersion":1,"type":"ready"}');
    const evalWorker = spawnSync(join(outputDir, binary), ['__kordi_smoke_eval'], {
      encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production', TMPDIR: tmpdir() },
    });
    if (evalWorker.status !== 0) throw new Error(`OMP native worker probe failed: ${evalWorker.stderr || evalWorker.stdout}`);
    expect(evalWorker.status).toBe(0);
    expect(evalWorker.stdout.trim()).toBe('eval-result-2;computer-capabilities-ready;browser-worker-closed');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 140_000);
