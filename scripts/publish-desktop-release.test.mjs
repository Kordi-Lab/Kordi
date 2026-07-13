import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  prepareDesktopRelease,
  publishDesktopRelease,
  redactPublisherText,
  releaseTreeScanArguments,
  verifyTauriUpdaterSignature,
} from './lib/desktop-release.mjs';
import {
  createS3ReleaseStore,
  parsePublisherArguments,
} from './publish-desktop-release.mjs';

const VERSION = '0.0.1-beta.6';
const PUB_DATE = '2026-07-13T00:00:00Z';
const TEST_PUBLIC_KEY_TEXT = [
  'untrusted comment: minisign public key E7620F1842B4E81F',
  'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
].join('\n');
const TEST_SIGNATURE_TEXT = [
  'untrusted comment: signature from minisign secret key',
  'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
  'trusted comment: timestamp:1556193335\tfile:test',
  'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
].join('\n');
const TEST_SIGNATURE = Buffer.from(TEST_SIGNATURE_TEXT).toString('base64');

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kordi-publisher-test-'));
  const releaseDir = join(root, 'release');
  const appBundle = join(root, 'Kordi.app');
  await mkdir(releaseDir);
  await mkdir(join(appBundle, 'Contents'), { recursive: true });
  const dmgName = `Kordi_${VERSION}_aarch64.dmg`;
  const archiveName = 'Kordi.app.tar.gz';
  const signatureName = `${archiveName}.sig`;
  const dmg = Buffer.from('signed notarized dmg fixture');
  const archive = Buffer.from('test');
  const signature = Buffer.from(`${TEST_SIGNATURE}\n`);
  await writeFile(join(releaseDir, dmgName), dmg);
  await writeFile(join(releaseDir, archiveName), archive);
  await writeFile(join(releaseDir, signatureName), signature);
  return {
    root,
    releaseDir,
    appBundle,
    dmgName,
    archiveName,
    signatureName,
    dmg,
    archive,
    signature,
  };
}

function optionsFor(fixture, overrides = {}) {
  return {
    releaseDir: fixture.releaseDir,
    appBundle: fixture.appBundle,
    version: VERSION,
    channel: 'beta',
    expectedCommit: '0123456789abcdef0123456789abcdef01234567',
    pubDate: PUB_DATE,
    ...overrides,
  };
}

function passingVerifier(calls = []) {
  return {
    async verify(input) {
      calls.push(input);
    },
  };
}

class MemoryStore {
  constructor(entries = []) {
    this.objects = new Map(entries.map(([key, value]) => [key, Buffer.from(value)]));
    this.actions = [];
  }

  async getObject(key) {
    this.actions.push({ type: 'get', key });
    const value = this.objects.get(key);
    return value === undefined ? null : Buffer.from(value);
  }

  async putObject(key, bytes, metadata) {
    this.actions.push({ type: 'put', key, metadata });
    this.objects.set(key, Buffer.from(bytes));
  }

  async deleteObject(key) {
    this.actions.push({ type: 'delete', key });
    this.objects.delete(key);
  }
}

function responseFor(bytes, digest, status = 200) {
  return {
    status,
    headers: {
      'content-length': String(bytes.length),
      'x-checksum-sha256': digest,
    },
    body: Buffer.from(bytes),
  };
}

function makePublicHttp(prepared, { failPostPromotion = false, wrongArchive = false } = {}) {
  const actions = [];
  const byUrl = new Map([
    [prepared.urls.manual, { bytes: prepared.artifacts.manual.bytes, digest: prepared.artifacts.manual.sha256 }],
    [prepared.urls.updaterArchive, {
      bytes: wrongArchive ? Buffer.from('tampered') : prepared.artifacts.updater.bytes,
      digest: prepared.artifacts.updater.sha256,
    }],
    [prepared.urls.stableManual, { bytes: prepared.artifacts.manual.bytes, digest: prepared.artifacts.manual.sha256 }],
  ]);
  const updateBody = Buffer.from(JSON.stringify({
    version: prepared.version,
    notes: prepared.release.notes,
    pub_date: prepared.pubDate,
    url: prepared.urls.updaterArchive,
    signature: prepared.release.platforms['darwin-aarch64'].signature,
  }));
  return {
    actions,
    async head(url) {
      actions.push({ method: 'HEAD', url });
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
    async get(url) {
      actions.push({ method: 'GET', url });
      if (url === prepared.urls.updaterEndpoint) {
        if (failPostPromotion) return { status: 503, headers: {}, body: Buffer.from('unavailable') };
        return { status: 200, headers: { 'content-length': String(updateBody.length) }, body: updateBody };
      }
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };
}

async function preparedFixture(fixture, overrides = {}) {
  return prepareDesktopRelease(optionsFor(fixture, overrides), {
    verifier: passingVerifier(),
  });
}

test('generates deterministic beta.6 metadata, keys, checksums, and product URLs', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const first = await preparedFixture(fixture);
  const second = await preparedFixture(fixture);

  assert.deepEqual(first.release, second.release);
  assert.deepEqual(first.pointer, second.pointer);
  assert.equal(first.release.version, VERSION);
  assert.equal(first.release.pubDate, PUB_DATE);
  assert.equal(first.release.manual.objectKey, `desktop/releases/${VERSION}/macos/aarch64/${fixture.dmgName}`);
  assert.equal(first.release.platforms['darwin-aarch64'].objectKey, `desktop/releases/${VERSION}/macos/aarch64/Kordi.app.tar.gz`);
  assert.equal(first.pointerKey, 'desktop/channels/beta/latest.json');
  assert.equal(first.pointer.releaseManifestKey, `desktop/releases/${VERSION}/release.json`);
  assert.equal(first.urls.manual, `https://coordinar.io/updates/releases/${VERSION}/${fixture.dmgName}`);
  assert.equal(first.urls.updaterArchive, `https://coordinar.io/updates/releases/${VERSION}/Kordi.app.tar.gz`);
  assert.equal(first.urls.updaterEndpoint, 'https://coordinar.io/updates/desktop/darwin/aarch64/0.0.0');
  assert.match(first.checksumsBytes.toString(), new RegExp(`${first.artifacts.manual.sha256}  macos/aarch64/${fixture.dmgName}`));
  assert.match(first.checksumsBytes.toString(), new RegExp(`${first.artifacts.updater.sha256}  macos/aarch64/Kordi\\.app\\.tar\\.gz`));
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'release.json')), first.releaseBytes);
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'checksums.sha256')), first.checksumsBytes);
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'channel-beta-latest.json')), first.pointerBytes);
});

test('cryptographically verifies Tauri minisign metadata and rejects changed bytes', () => {
  const publicKey = Buffer.from(TEST_PUBLIC_KEY_TEXT).toString('base64');
  assert.doesNotThrow(() => verifyTauriUpdaterSignature(Buffer.from('test'), TEST_SIGNATURE, publicKey));
  assert.throws(
    () => verifyTauriUpdaterSignature(Buffer.from('changed'), TEST_SIGNATURE, publicKey),
    /signature verification failed/i,
  );
});

test('invalid inputs and every local release-gate failure stop before storage access', async (t) => {
  const cases = [
    ['invalid version', { version: '../beta.6' }],
    ['dirty worktree', { verifierError: 'Release worktree must be clean' }],
    ['wrong commit', { verifierError: 'Current commit does not match expected release commit' }],
    ['wrong app version', { verifierError: 'Kordi.app version does not match release version' }],
    ['wrong hashes', { verifierError: 'Updater signature verification failed' }],
    ['DMG layout', { verifierError: 'Missing Applications symlink' }],
    ['privacy scan', { verifierError: 'Release privacy scan found a forbidden value' }],
    ['codesign', { verifierError: 'codesign verification failed' }],
    ['Gatekeeper', { verifierError: 'Gatekeeper assessment failed' }],
  ];

  for (const [name, spec] of cases) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture();
      t.after(() => rm(fixture.root, { recursive: true, force: true }));
      const store = new MemoryStore();
      const verifier = spec.verifierError
        ? { async verify() { throw new Error(spec.verifierError); } }
        : passingVerifier();
      await assert.rejects(
        publishDesktopRelease(optionsFor(fixture, spec.version ? { version: spec.version } : {}), {
          verifier,
          store,
          publicHttp: {},
        }),
      );
      assert.deepEqual(store.actions, []);
    });
  }
});

test('missing artifacts, app bundle, and template signatures stop before storage access', async (t) => {
  for (const missing of ['dmgName', 'archiveName', 'signatureName', 'appBundle']) {
    await t.test(`missing ${missing}`, async (t) => {
      const fixture = await makeFixture();
      t.after(() => rm(fixture.root, { recursive: true, force: true }));
      const missingPath = missing === 'appBundle'
        ? fixture.appBundle
        : join(fixture.releaseDir, fixture[missing]);
      await rm(missingPath, { recursive: true, force: true });
      const store = new MemoryStore();
      await assert.rejects(
        publishDesktopRelease(optionsFor(fixture), { verifier: passingVerifier(), store, publicHttp: {} }),
        /missing|required|does not exist/i,
      );
      assert.deepEqual(store.actions, []);
    });
  }

  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.releaseDir, fixture.signatureName), Buffer.from('TEMPLATE_SIGNATURE'));
  const store = new MemoryStore();
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), { verifier: passingVerifier(), store, publicHttp: {} }),
    /signature/i,
  );
  assert.deepEqual(store.actions, []);
});

test('immutable equal bytes are idempotent and different bytes are a hard conflict', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const manualKey = prepared.release.manual.objectKey;
  const equalStore = new MemoryStore([[manualKey, fixture.dmg]]);
  const publicHttp = makePublicHttp(prepared);
  await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store: equalStore,
    publicHttp,
  });
  assert.equal(equalStore.actions.some((action) => action.type === 'put' && action.key === manualKey), false);

  const conflictStore = new MemoryStore([[manualKey, Buffer.from('different immutable bytes')]]);
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store: conflictStore,
      publicHttp: makePublicHttp(prepared),
    }),
    /immutable object conflict/i,
  );
  assert.equal(conflictStore.actions.some((action) => action.type === 'put'), false);
});

test('uploads immutable objects, verifies product GET and HEAD, and writes the pointer last', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();
  const publicHttp = makePublicHttp(prepared);

  await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store,
    publicHttp,
  });

  const puts = store.actions.filter((action) => action.type === 'put');
  assert.equal(puts.at(-1).key, prepared.pointerKey);
  assert.ok(puts.slice(0, -1).every((action) => action.key.startsWith(`desktop/releases/${VERSION}/`)));
  assert.deepEqual(
    publicHttp.actions.slice(0, 4).map(({ method, url }) => [method, url]),
    [
      ['HEAD', prepared.urls.manual],
      ['GET', prepared.urls.manual],
      ['HEAD', prepared.urls.updaterArchive],
      ['GET', prepared.urls.updaterArchive],
    ],
  );
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.urls.updaterEndpoint), true);
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.urls.stableManual), true);
});

test('a public digest mismatch prevents pointer promotion', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp: makePublicHttp(prepared, { wrongArchive: true }),
    }),
    /digest|length/i,
  );
  assert.equal(store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey), false);
});

test('failed post-promotion verification restores exact prior pointer bytes', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const previous = Buffer.from('{"exact":"previous pointer bytes"}\n');
  const store = new MemoryStore([[prepared.pointerKey, previous]]);
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp: makePublicHttp(prepared, { failPostPromotion: true }),
    }),
    /post-promotion|updater endpoint/i,
  );
  assert.deepEqual(store.objects.get(prepared.pointerKey), previous);
  const pointerMutations = store.actions.filter((action) => action.key === prepared.pointerKey && action.type !== 'get');
  assert.deepEqual(pointerMutations.map((action) => action.type), ['put', 'put']);
});

test('failed first promotion removes the new pointer during rollback', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp: makePublicHttp(prepared, { failPostPromotion: true }),
    }),
  );
  assert.equal(store.objects.has(prepared.pointerKey), false);
  assert.equal(store.actions.some((action) => action.type === 'delete' && action.key === prepared.pointerKey), true);
});

test('dry-run executes local validation and writes metadata without network mutation', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const verifierCalls = [];
  const store = new MemoryStore();
  const result = await publishDesktopRelease(optionsFor(fixture, { dryRun: true }), {
    verifier: passingVerifier(verifierCalls),
    store,
    publicHttp: { async get() { throw new Error('network called'); } },
  });
  assert.equal(result.dryRun, true);
  assert.equal(verifierCalls.length, 1);
  assert.deepEqual(store.actions, []);
  assert.equal((await readFile(join(fixture.releaseDir, 'release.json'))).length > 0, true);
});

test('publisher error redaction removes credentials, signing material, and internal endpoints', () => {
  const env = {
    KORDI_RELEASE_PUBLISHER_ACCESS_KEY: 'publisher-access-123',
    KORDI_RELEASE_PUBLISHER_SECRET_KEY: 'publisher-secret-456',
    TAURI_SIGNING_PRIVATE_KEY: 'private-updater-key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'signature-password',
  };
  const redacted = redactPublisherText(
    'publisher-access-123 publisher-secret-456 private-updater-key signature-password http://minio.kordi-cloud.svc.cluster.local:9000/path',
    env,
  );
  for (const secret of Object.values(env)) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.doesNotMatch(redacted, /minio|svc\.cluster\.local/i);
  assert.match(redacted, /REDACTED/);
});

test('privacy scanning includes ignored build outputs and every mounted release file', () => {
  const args = releaseTreeScanArguments('/tmp/Kordi.app');
  assert.ok(args.includes('--no-ignore'));
  assert.ok(args.includes('--hidden'));
  assert.ok(args.includes('--text'));
  assert.equal(args.at(-1), '/tmp/Kordi.app');
});

test('publisher CLI requires the exact release inputs and accepts pnpm separators', () => {
  assert.deepEqual(parsePublisherArguments([
    '--',
    '--release-dir', '/tmp/release',
    '--app-bundle', '/tmp/Kordi.app',
    '--version', VERSION,
    '--channel', 'acceptance',
    '--expected-commit', '0123456789abcdef0123456789abcdef01234567',
    '--pub-date', PUB_DATE,
    '--dry-run',
  ]), {
    releaseDir: '/tmp/release',
    appBundle: '/tmp/Kordi.app',
    version: VERSION,
    channel: 'acceptance',
    expectedCommit: '0123456789abcdef0123456789abcdef01234567',
    pubDate: PUB_DATE,
    dryRun: true,
  });
  assert.throws(() => parsePublisherArguments(['--version']), /requires a value/i);
  assert.throws(() => parsePublisherArguments(['--unexpected']), /unknown publisher argument/i);
});

test('S3 adapter uses path-scoped credentials and conditional immutable writes', async () => {
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: { async transformToByteArray() { return Uint8Array.from([1, 2, 3]); } } };
      }
      return {};
    },
  };
  const store = await createS3ReleaseStore({
    client,
    env: {
      KORDI_RELEASE_S3_ENDPOINT: 'http://127.0.0.1:9900',
      KORDI_RELEASE_S3_BUCKET: 'kordi-releases',
      KORDI_RELEASE_S3_REGION: 'us-east-1',
      KORDI_RELEASE_PUBLISHER_ACCESS_KEY: 'test-access',
      KORDI_RELEASE_PUBLISHER_SECRET_KEY: 'test-secret',
    },
  });
  assert.deepEqual(await store.getObject('desktop/releases/test'), Buffer.from([1, 2, 3]));
  await store.putObject('desktop/releases/test', Buffer.from('immutable'), {
    immutable: true,
    contentType: 'application/octet-stream',
    cacheControl: 'immutable',
  });
  await store.putObject('desktop/channels/beta/latest.json', Buffer.from('{}'), {
    contentType: 'application/json',
  });
  await store.deleteObject('desktop/channels/beta/latest.json');

  assert.equal(commands[1].constructor.name, 'PutObjectCommand');
  assert.equal(commands[1].input.Bucket, 'kordi-releases');
  assert.equal(commands[1].input.IfNoneMatch, '*');
  assert.equal(commands[2].input.IfNoneMatch, undefined);
  assert.equal(commands[3].constructor.name, 'DeleteObjectCommand');
});
