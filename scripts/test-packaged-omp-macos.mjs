#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackagedOmp } from './check-packaged-omp.mjs';

// Run in macOS CI after check:omp installed the pinned worker dependencies.
assert.equal(process.platform, 'darwin', 'This regression requires macOS code signing.');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staging = mkdtempSync(join(tmpdir(), 'kordi signing regression '));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, `${command} failed; private build output omitted.`);
  return result.stdout;
}
try {
  const triple = run('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
  assert.ok(triple);
  run('node', ['shared/omp-runtime/scripts/build-standalone.mjs', staging, triple]);
  const worker = join(staging, 'kordi-omp');
  copyFileSync(join(staging, `kordi-omp-${triple}`), worker);
  const addon = join(staging, `pi_natives.darwin-${process.arch}.node`);
  const base = 'app/desktop/src-tauri/Entitlements.plist';
  const preview = 'app/desktop/src-tauri/Entitlements.preview.plist';
  const sign = (path, entitlements) => run('codesign', [
    '--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, path,
  ]);
  const baseEntitlements = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', base]));
  const previewEntitlements = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', preview]));
  assert.equal(baseEntitlements['com.apple.security.cs.disable-library-validation'], undefined);
  assert.deepEqual(previewEntitlements, { ...baseEntitlements, 'com.apple.security.cs.disable-library-validation': true });
  // Match Tauri's ad-hoc signing of both externalBin entries. Version alone passes.
  sign(addon, base);
  sign(worker, base);
  assert.match(run(worker, ['--version']), /^kordi-omp /);
  await assert.rejects(checkPackagedOmp(worker), /exited before completing/);
  sign(worker, preview);
  run('codesign', ['--verify', '--strict', worker]);
  assert.deepEqual(await checkPackagedOmp(worker), { ready: true, syntheticRequest: true });
  for (const name of ['tauri.cloud.acceptance.conf.json', 'tauri.cloud.acceptance-bootstrap.conf.json']) {
    const config = JSON.parse(readFileSync(join(root, 'app/desktop/src-tauri', name), 'utf8'));
    assert.equal(config.bundle.macOS.entitlements, './Entitlements.preview.plist');
  }
  const generated = run('node', ['app/desktop/scripts/tauri-dev-profile.mjs', '--profile', 'signing-regression', '--dry-run'], {
    ...process.env, VITE_KORDI_DEV_PROFILE: 'community', VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
  });
  const profile = JSON.parse(generated.slice(generated.indexOf('{')));
  assert.equal(profile.bundle.macOS.entitlements, './Entitlements.preview.plist');
  assert.equal(profile.bundle.macOS.signingIdentity, '-');
  console.log('Reproduced ad-hoc addon rejection; preview signing passes the real worker protocol.');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
