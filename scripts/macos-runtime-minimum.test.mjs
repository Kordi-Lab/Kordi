import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMachOMinimum, checkMacOSRuntimeMinimum } from './check-macos-runtime-minimum.mjs';

const modern = (version) => `Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos ${version}\n sdk 27.0`;

test('checks every architecture minimum and supports older deployment commands', () => {
  assert.doesNotThrow(() => assertMachOMinimum(`${modern('13.0')}\nLoad command 2\n cmd LC_VERSION_MIN_MACOSX\n version 12.0`, '13.0'));
  assert.throws(() => assertMachOMinimum(`${modern('13.0')}\n${modern('14.0')}`, '13.0'), /newer macOS/);
  assert.throws(() => assertMachOMinimum(modern('13.1'), '13.0'), /newer macOS/);
  assert.throws(() => assertMachOMinimum(modern('13.0').replace('platform 1', 'platform 2'), '13.0'), /non-macOS/);
  assert.throws(() => assertMachOMinimum('unrecognized output', '13.0'), /Missing/);
});

test('bundle gate detects the original app12/runtime13 mismatch and nested native dependencies', (t) => {
  const app = mkdtempSync(join(tmpdir(), 'kordi-minimum-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const binaries = ['Contents/MacOS/kordi-desktop', 'Contents/MacOS/kordi-omp', 'Contents/Frameworks/Native.framework/Versions/A/Native'];
  for (const binary of binaries) {
    mkdirSync(join(app, binary, '..'), { recursive: true });
    writeFileSync(join(app, binary), Buffer.from('cffaedfe', 'hex'));
  }
  let advertised = '12.0';
  let dependency = '13.0';
  const run = (command, args) => ({ status: 0, stdout: command === 'plutil' ? advertised : modern(args.at(-1).endsWith('kordi-desktop') ? '12.0' : dependency) });
  assert.throws(() => checkMacOSRuntimeMinimum(app, { expectedMinimum: '12.0', run }), /newer macOS/);
  assert.throws(() => checkMacOSRuntimeMinimum(app, { run }), /App minimum/);
  advertised = '13.0';
  assert.equal(checkMacOSRuntimeMinimum(app, { run }).binaryCount, 3);
  dependency = '14.0';
  assert.throws(() => checkMacOSRuntimeMinimum(app, { run }), /newer macOS/);
});
