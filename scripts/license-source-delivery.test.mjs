import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from './licenses.mjs';
import { packageSourceKit, prepareSourceKit, publishSourceKit } from './licenses/source-delivery.mjs';
function fixture(t) {
  const input = mkdtempSync(join(tmpdir(), 'source-kit-input-')), output = mkdtempSync(join(tmpdir(), 'source-kit-output-'));
  t.after(() => { rmSync(input, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); });
  const sources = {};
  for (const name of ['bun', 'javascriptcore', 'tinycc', 'application', 'relink-instructions', 'bun-build-inputs', 'bun-rust-dependencies', 'application-dependencies', 'build-patches']) {
    const path = name + '.txt', text = `Synthetic ${name} source fixture`;
    writeFileSync(join(input, path), text); sources[name] = { path, sha256: sha256(text) };
  }
  writeFileSync(join(input, 'source-manifest.json'), JSON.stringify({ sources, releaseCommit: 'a'.repeat(40), catalogSha256: 'b'.repeat(64) }));
  const identity = { version: '1.2.3', releaseCommit: 'a'.repeat(40), catalogSha256: 'b'.repeat(64), pubDate: '2026-01-01T00:00:00Z' };
  return { output, identity, kit: packageSourceKit(input, output, identity) };
}
test('source delivery binds every reassembled material to the release identity', (t) => {
  const { output, identity, kit } = fixture(t);
  assert.equal(prepareSourceKit(output, identity).sha256, kit.sha256);
  assert.throws(() => prepareSourceKit(output, { ...identity, releaseCommit: 'c'.repeat(40) }), /stale releaseCommit/);
  writeFileSync(join(output, kit.manifest.files[0].fileName), 'tampered');
  assert.throws(() => prepareSourceKit(output, identity), /missing or changed/);
});
test('source manifest cannot reuse parts or reorder source bytes silently', (t) => {
  const { output, identity } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  manifest.materials[1].files = manifest.materials[0].files;
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => prepareSourceKit(output, identity), /reused/);
});
test('publication verifies anonymous downloads and refuses immutable conflicts', async (t) => {
  const { kit } = fixture(t), objects = new Map();
  const store = { getObject: async (key) => objects.get(key), putObject: async (key, bytes) => objects.set(key, bytes) };
  const http = { get: async (url) => ({ status: 200, body: objects.get('desktop/releases/1.2.3/sources/' + url.split('/').at(-1)) }) };
  await publishSourceKit(kit, store, http);
  assert.equal(objects.size, 10);
  await assert.rejects(publishSourceKit(kit, store, { get: async () => ({ status: 404 }) }), /Public source download/);
  objects.set('desktop/releases/1.2.3/sources/manifest.json', Buffer.from('different'));
  await assert.rejects(publishSourceKit(kit, store, http), /Immutable source-kit conflict/);
});

test('source downloader reconstructs verified bytes and rejects unsafe outputs', () => {
  const result = spawnSync('python3', ['-B', 'scripts/licenses/download-sources_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
