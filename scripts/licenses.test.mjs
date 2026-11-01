import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, distributionFiles, stageDistribution, verifyDistribution, validateCatalog } from './licenses.mjs';
import { stageRuntimeLicenses } from '../shared/omp-runtime/scripts/runtime-licenses.mjs';
import { verifyReleaseLicenseEvidence } from './licenses/release-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kordi-license-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, text) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text); };
  for (const name of ['LICENSE', 'NOTICE', 'legal/SOURCES.md', 'legal/native/WebRTC-LICENSE', 'legal/native/WebRTC-THIRD-PARTY-NOTICES.txt', 'legal/native/UniFFI-THIRD-PARTY-NOTICES.txt', 'legal/native/Bun-THIRD-PARTY-NOTICES.txt', 'legal/native/webrtc-dependencies.json', 'legal/native/uniffi-dependencies.json', 'legal/native/bun-dependencies.json',
    'shared/noto-emoji/NOTICE.txt', 'shared/blob-emoji/LICENSE.txt',
    'app/desktop/public/noto-thumbnails.LICENSE.txt', 'app/desktop/public/noto-static-symbols.APACHE-LICENSE.txt',
    'app/desktop/public/blob-wave.LICENSE.txt', 'app/desktop/public/provider-logos/LICENSES.md',
    'app/desktop/public/provider-logos/LOBE-ICONS-LICENSE', 'shared/digest/ICAL-LICENSE',
    'shared/digest/README.md', 'bridges/cloud-server/src/avatars/boring-avatars-LICENSE']) put(name, 'Synthetic notice for ' + name);
  put('example.lock', 'locked version 1');
  const text = 'Copyright Synthetic Authors\n<script>alert("not executable")</script>';
  const catalog = { schemaVersion: 1, scope: 'Synthetic test inventory', inputs: { 'example.lock': sha256('locked version 1') },
    packages: [{ ecosystem: 'test', name: '<unsafe & package>', version: '1', license: 'MIT', source: 'https://example.test/source', notices: [{ file: 'LICENSE', sha256: sha256(text) }] }],
    documents: { [sha256(text)]: text }, standardLicenses: { MIT: 'Synthetic MIT license text' } };
  put('legal/catalog.json', JSON.stringify(catalog));
  return { root, put, catalog, text };
}

test('stage preserves upstream notices and escapes untrusted HTML', (t) => {
  const { root, text } = fixture(t);
  stageDistribution(join(root, 'out'), root);
  verifyDistribution(join(root, 'out'), distributionFiles(root));
  const html = readFileSync(join(root, 'out/index.html'), 'utf8');
  assert.ok(html.includes('&lt;unsafe &amp; package&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(readFileSync(join(root, 'out/THIRD-PARTY-NOTICES.txt'), 'utf8').includes(text));
});

test('lock updates and missing original notices fail closed', (t) => {
  const { root, put, catalog } = fixture(t);
  delete catalog.documents[catalog.packages[0].notices[0].sha256];
  assert.throws(() => validateCatalog(catalog, root), /Missing notice/);
  put('example.lock', 'different version');
  assert.throws(() => distributionFiles(root), /review is stale/);
});

test('verification rejects a removed or modified packaged notice', (t) => {
  const { root } = fixture(t);
  stageDistribution(join(root, 'out'), root);
  writeFileSync(join(root, 'out/NOTICE'), 'tampered');
  assert.throws(() => verifyDistribution(join(root, 'out'), distributionFiles(root)), /Missing or stale/);
});

function releaseFixture(t) {
  const f = fixture(t);
  const app = join(f.root, 'Kordi.app');
  stageDistribution(join(app, 'Contents/Resources/licenses'), f.root);
  const putApp = (name, content) => f.put('Kordi.app/' + name, content);
  const artifacts = {};
  for (const name of ['kordi-omp', 'pi_natives.darwin-arm64.node']) {
    const path = `Contents/MacOS/${name}`;
    putApp(path, 'synthetic binary'); artifacts[path] = sha256('synthetic binary');
  }
  const sources = {};
  for (const name of ['bun', 'javascriptcore', 'tinycc', 'application', 'relink-instructions']) {
    const path = `Contents/Resources/licenses/sources/${name}.txt`;
    putApp(path, 'synthetic source fixture'); sources[name] = { path, sha256: sha256('synthetic source fixture') };
  }
  const evidence = { schemaVersion: 1, reviewStatus: 'complete', catalogSha256: sha256(readFileSync(join(f.root, 'legal/catalog.json'))),
    artifacts, sources, reviews: Object.fromEntries(['bun-javascriptcore', 'bun-tinycc', 'omp-native-addon', 'optional-libvips'].map((name) => [name, 'Synthetic review fixture, not a compliance statement.'])) };
  f.put('legal/runtime-sources.json', JSON.stringify({ sources: Object.fromEntries(['bun', 'javascriptcore', 'tinycc'].map((name) => [name, { sha256: sources[name].sha256 }])) }));
  const path = join(f.root, 'evidence.json');
  const save = () => writeFileSync(path, JSON.stringify(evidence));
  save();
  return { ...f, app, path, evidence, save };
}

test('publisher requires source/relink evidence bound to final binaries', (t) => {
  const { app, path, root, evidence, save } = releaseFixture(t);
  assert.throws(() => verifyReleaseLicenseEvidence(app, undefined, root), /evidence is required/);
  verifyReleaseLicenseEvidence(app, path, root);
  evidence.artifacts['Contents/MacOS/kordi-omp'] = '0'.repeat(64); save();
  assert.throws(() => verifyReleaseLicenseEvidence(app, path, root), /does not match/);
});

test('builder-only sources and symlink escapes cannot satisfy delivery', (t) => {
  const { root, app, path, evidence, save, put } = releaseFixture(t);
  evidence.sources.bun.path = '../outside.tar.gz'; save();
  assert.throws(() => verifyReleaseLicenseEvidence(app, path, root), /inside the distributed app/);
  const relative = 'Contents/Resources/licenses/sources/escape.txt';
  put('outside.txt', 'synthetic source fixture');
  symlinkSync(join(root, 'outside.txt'), join(app, relative));
  evidence.sources.bun.path = relative; save();
  assert.throws(() => verifyReleaseLicenseEvidence(app, path, root), /symlink/);
});

test('release source files must match pinned upstream archives', (t) => {
  const { app, path, root, evidence, save } = releaseFixture(t);
  evidence.sources.bun.sha256 = '1'.repeat(64); save();
  assert.throws(() => verifyReleaseLicenseEvidence(app, path, root), /pinned bun archive/);
});

test('runtime packaging rejects compiler upgrades and changed lockfiles', (t) => {
  const { root, put, catalog } = fixture(t);
  const inputs = {
    'shared/omp-runtime/package.json': JSON.stringify({ packageManager: 'bun@1.4.2', dependencies: { '@oh-my-pi/pi-coding-agent': '18.12.6' } }),
    'shared/omp-runtime/bun.lock': 'synthetic locked packages',
  };
  for (const [name, text] of Object.entries(inputs)) { put(name, text); catalog.inputs[name] = sha256(text); }
  put('legal/catalog.json', JSON.stringify(catalog));
  stageDistribution(join(root, 'legal/distribution'), root);
  const runtime = join(root, 'shared/omp-runtime');
  const output = join(root, 'runtime-out');
  assert.throws(() => stageRuntimeLicenses(runtime, output, '1.5.0', 'synthetic-target'), /licensed runtime/);
  stageRuntimeLicenses(runtime, output, '1.4.2', 'synthetic-target');
  verifyDistribution(join(output, 'licenses'), distributionFiles(root));
  assert.equal(JSON.parse(readFileSync(join(output, 'licenses/runtime-build.json'), 'utf8')).bunVersion, '1.4.2');
  put('shared/omp-runtime/bun.lock', 'unreviewed package update');
  assert.throws(() => stageRuntimeLicenses(runtime, output, '1.4.2', 'synthetic-target'), /stale/);
});
