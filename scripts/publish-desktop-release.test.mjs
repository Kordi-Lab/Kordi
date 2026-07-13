import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearDesktopReleaseChannel,
  prepareDesktopRelease,
  publishDesktopRelease,
  redactPublisherText,
  releaseTreeScanArguments,
  rollbackDesktopBetaChannel,
  verifyTauriUpdaterSignature,
} from './lib/desktop-release.mjs';
import {
  createS3ReleaseStore,
  parsePublisherArguments,
} from './publish-desktop-release.mjs';

const VERSION = '0.0.1-beta.6';
const PREVIOUS_VERSION = '0.0.1-beta.5';
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
const TEST_PUBLIC_KEY = Buffer.from(TEST_PUBLIC_KEY_TEXT).toString('base64');

async function makeFixture(version = VERSION) {
  const root = await mkdtemp(join(tmpdir(), 'kordi-publisher-test-'));
  const releaseDir = join(root, 'release');
  const appBundle = join(root, 'Kordi.app');
  await mkdir(releaseDir);
  await mkdir(join(appBundle, 'Contents'), { recursive: true });
  const dmgName = `Kordi_${version}_aarch64.dmg`;
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
    this.revision = 0;
    this.objects = new Map(entries.map(([key, value]) => [key, this.#record(value)]));
    this.actions = [];
  }

  #record(value) {
    const bytes = Buffer.from(value?.bytes ?? value);
    const etag = value?.etag ?? `"memory-${createHash('sha256').update(bytes).digest('hex')}-${this.revision += 1}"`;
    return { bytes, etag, versionId: `memory-version-${this.revision}` };
  }

  async getObject(key) {
    this.actions.push({ type: 'get', key });
    const value = this.objects.get(key);
    return value === undefined ? null : { ...value, bytes: Buffer.from(value.bytes) };
  }

  async putObject(key, bytes, metadata) {
    const action = { type: 'put', key, metadata };
    this.actions.push(action);
    const current = this.objects.get(key);
    if (metadata?.ifNoneMatch === '*' && current) throw new Error(`precondition failed for ${key}`);
    if (metadata?.ifMatch && current?.etag !== metadata.ifMatch) throw new Error(`precondition failed for ${key}`);
    if (metadata?.ifMatch && !current) throw new Error(`precondition failed for ${key}`);
    const record = this.#record(bytes);
    this.objects.set(key, record);
    action.resultEtag = record.etag;
    return { etag: record.etag, versionId: record.versionId };
  }

  async deleteObject(key, metadata = {}) {
    this.actions.push({ type: 'delete', key, metadata });
    const current = this.objects.get(key);
    if (metadata.ifMatch && current?.etag !== metadata.ifMatch) throw new Error(`precondition failed for ${key}`);
    this.objects.delete(key);
  }

  forcePut(key, bytes) {
    this.objects.set(key, this.#record(bytes));
  }

  bytes(key) {
    return this.objects.get(key)?.bytes;
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

function makePublicHttp(prepared, {
  failPostPromotion = false,
  wrongArchive = false,
  previousPrepared = null,
  onPostPromotionFailure = null,
} = {}) {
  const actions = [];
  const byUrl = new Map([
    [prepared.urls.manual, { bytes: prepared.artifacts.manual.bytes, digest: prepared.artifacts.manual.sha256 }],
    [prepared.urls.updaterArchive, {
      bytes: wrongArchive ? Buffer.from('tampered') : prepared.artifacts.updater.bytes,
      digest: prepared.artifacts.updater.sha256,
    }],
  ]);
  if (previousPrepared) {
    byUrl.set(previousPrepared.urls.manual, {
      bytes: previousPrepared.artifacts.manual.bytes,
      digest: previousPrepared.artifacts.manual.sha256,
    });
    byUrl.set(previousPrepared.urls.updaterArchive, {
      bytes: previousPrepared.artifacts.updater.bytes,
      digest: previousPrepared.artifacts.updater.sha256,
    });
  }
  let postPromotionFailed = false;
  const updateResponse = (release) => Buffer.from(JSON.stringify({
    version: release.version,
    notes: release.release.notes,
    pub_date: release.pubDate,
    url: release.urls.updaterArchive,
    signature: release.release.platforms['darwin-aarch64'].signature,
  }));
  const stableAsset = () => (postPromotionFailed ? previousPrepared?.artifacts.manual : prepared.artifacts.manual);
  return {
    actions,
    async head(url) {
      actions.push({ method: 'HEAD', url });
      if (url === prepared.urls.stableManual) {
        const found = stableAsset();
        return found ? responseFor(found.bytes, found.sha256) : { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
    async get(url) {
      actions.push({ method: 'GET', url });
      if (url === prepared.urls.updaterEndpoint) {
        if (failPostPromotion && !postPromotionFailed) {
          postPromotionFailed = true;
          onPostPromotionFailure?.();
          return { status: 503, headers: {}, body: Buffer.from('unavailable') };
        }
        const selected = postPromotionFailed ? previousPrepared : prepared;
        if (!selected) return { status: 204, headers: {}, body: Buffer.alloc(0) };
        const updateBody = updateResponse(selected);
        return { status: 200, headers: { 'content-length': String(updateBody.length) }, body: updateBody };
      }
      if (url === 'https://coordinar.io/updates/releases/version' && postPromotionFailed && !previousPrepared) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            version: '0.0.1-beta.5',
            changelogUrl: 'https://coordinar.io/updates/releases/version',
          })),
        };
      }
      if (url === prepared.urls.stableManual) {
        const found = stableAsset();
        return found ? responseFor(found.bytes, found.sha256) : { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const found = byUrl.get(url);
      return found ? responseFor(found.bytes, found.digest) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };
}

function storedReleaseEntries(prepared, { includePointer = true } = {}) {
  const entries = prepared.immutableObjects.map((object) => [object.key, object.bytes]);
  if (includePointer) entries.push([prepared.pointerKey, prepared.pointerBytes]);
  return entries;
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
  assert.equal(puts.at(-1).metadata.ifNoneMatch, '*');
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
      updaterPublicKey: TEST_PUBLIC_KEY,
      store,
      publicHttp: makePublicHttp(prepared, { wrongArchive: true }),
    }),
    /digest|length/i,
  );
  assert.equal(store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey), false);
});

test('failed post-promotion verification restores exact prior pointer bytes', async (t) => {
  const fixture = await makeFixture();
  const previousFixture = await makeFixture(PREVIOUS_VERSION);
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(previousFixture.root, { recursive: true, force: true }),
  ]));
  const prepared = await preparedFixture(fixture);
  const previous = await preparedFixture(previousFixture, { version: PREVIOUS_VERSION });
  const store = new MemoryStore(storedReleaseEntries(previous));
  const priorEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;
  const publicHttp = makePublicHttp(prepared, {
    failPostPromotion: true,
    previousPrepared: previous,
  });
  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      updaterPublicKey: TEST_PUBLIC_KEY,
      store,
      publicHttp,
    }),
    /post-promotion|updater endpoint/i,
  );
  assert.deepEqual(store.bytes(prepared.pointerKey), previous.pointerBytes);
  const pointerMutations = store.actions.filter((action) => action.key === prepared.pointerKey && action.type !== 'get');
  assert.deepEqual(pointerMutations.map((action) => action.type), ['put', 'put']);
  assert.equal(pointerMutations[0].metadata.ifMatch, priorEtag);
  assert.equal(pointerMutations[1].metadata.ifMatch, pointerMutations[0].resultEtag);
  assert.ok(store.actions.filter((action) => action.type === 'get' && action.key === prepared.pointerKey).length >= 2);
  assert.ok(publicHttp.actions.some((action) => action.method === 'GET' && action.url === previous.urls.updaterArchive));
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
  const deletion = store.actions.find((action) => action.type === 'delete' && action.key === prepared.pointerKey);
  assert.ok(deletion?.metadata.ifMatch);
});

test('a pointer read-back failure still rolls back the exact first promotion', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const baseStore = new MemoryStore();
  let failPointerRead = false;
  const store = {
    async getObject(key) {
      if (key === prepared.pointerKey && failPointerRead) {
        failPointerRead = false;
        throw new Error('simulated pointer read-back outage');
      }
      return baseStore.getObject(key);
    },
    async putObject(key, bytes, metadata) {
      const result = await baseStore.putObject(key, bytes, metadata);
      if (key === prepared.pointerKey) failPointerRead = true;
      return result;
    },
    async deleteObject(key, metadata) {
      return baseStore.deleteObject(key, metadata);
    },
  };
  const baseHttp = makePublicHttp(prepared);
  const publicHttp = {
    async head(url) {
      if (url === prepared.urls.stableManual && !baseStore.objects.has(prepared.pointerKey)) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return baseHttp.head(url);
    },
    async get(url) {
      if (!baseStore.objects.has(prepared.pointerKey)) {
        if (url === prepared.urls.updaterEndpoint) return { status: 204, headers: {}, body: Buffer.alloc(0) };
        if (url === prepared.urls.stableManual) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        if (url === 'https://coordinar.io/updates/releases/version') {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({
              version: '0.0.1-beta.5',
              changelogUrl: 'https://coordinar.io/updates/releases/version',
            })),
          };
        }
      }
      return baseHttp.get(url);
    },
  };

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp,
    }),
    /read-back|post-promotion/i,
  );
  assert.equal(baseStore.objects.has(prepared.pointerKey), false);
  const deletion = baseStore.actions.find((action) => action.type === 'delete');
  assert.equal(deletion.metadata.ifMatch, baseStore.actions.find((action) => action.type === 'put' && action.key === prepared.pointerKey).resultEtag);
});

test('invalid prior channel metadata fails before pointer promotion', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore([[prepared.pointerKey, Buffer.from('{"not":"a channel pointer"}\n')]]);

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp: makePublicHttp(prepared),
    }),
    /prior channel pointer|invalid/i,
  );
  assert.equal(
    store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey),
    false,
  );
});

test('a failed publisher cannot roll back a newer concurrent promotion', async (t) => {
  const fixture = await makeFixture();
  const previousFixture = await makeFixture(PREVIOUS_VERSION);
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(previousFixture.root, { recursive: true, force: true }),
  ]));
  const prepared = await preparedFixture(fixture);
  const previous = await preparedFixture(previousFixture, { version: PREVIOUS_VERSION });
  const store = new MemoryStore(storedReleaseEntries(previous));
  const concurrentPointer = Buffer.from('{"newer":"publisher"}\n');

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      updaterPublicKey: TEST_PUBLIC_KEY,
      store,
      publicHttp: makePublicHttp(prepared, {
        failPostPromotion: true,
        previousPrepared: previous,
        onPostPromotionFailure: () => store.forcePut(prepared.pointerKey, concurrentPointer),
      }),
    }),
    /rollback also failed|concurrent|precondition/i,
  );
  assert.deepEqual(store.bytes(prepared.pointerKey), concurrentPointer);
});

test('acceptance cleanup conditionally removes its pointer and verifies 204', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, { channel: 'acceptance' });
  const store = new MemoryStore(storedReleaseEntries(prepared));
  const priorEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;
  const publicHttp = {
    async get(url) {
      assert.equal(url, prepared.urls.updaterEndpoint);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    },
    async head() { throw new Error('acceptance cleanup must not read beta stable assets'); },
  };

  const result = await clearDesktopReleaseChannel(
    { channel: 'acceptance' },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );

  assert.equal(result.removed, true);
  assert.equal(store.objects.has(prepared.pointerKey), false);
  const deletion = store.actions.find((action) => action.type === 'delete');
  assert.equal(deletion.metadata.ifMatch, priorEtag);
});

test('failed acceptance cleanup restores and reverifies the exact prior pointer', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, { channel: 'acceptance' });
  const store = new MemoryStore(storedReleaseEntries(prepared));
  let endpointReads = 0;
  const publicHttp = {
    async get(url) {
      assert.equal(url, prepared.urls.updaterEndpoint);
      endpointReads += 1;
      if (endpointReads === 1) return { status: 503, headers: {}, body: Buffer.from('stale') };
      const body = Buffer.from(JSON.stringify({
        version: prepared.version,
        notes: prepared.release.notes,
        pub_date: prepared.pubDate,
        url: prepared.urls.updaterArchive,
        signature: prepared.release.platforms['darwin-aarch64'].signature,
      }));
      return { status: 200, headers: {}, body };
    },
    async head() { throw new Error('acceptance cleanup must not read beta stable assets'); },
  };

  await assert.rejects(
    clearDesktopReleaseChannel(
      { channel: 'acceptance' },
      { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
    ),
    /cleanup verification failed|restored/i,
  );
  assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
  const mutations = store.actions.filter((action) => ['delete', 'put'].includes(action.type));
  assert.deepEqual(mutations.map((action) => action.type), ['delete', 'put']);
  assert.equal(mutations[1].metadata.ifNoneMatch, '*');
  assert.equal(endpointReads, 2);
});

test('beta rollback deletes only the expected current release and verifies safe fallback', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore(storedReleaseEntries(prepared));
  const priorEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;
  const publicHttp = {
    async get(url) {
      if (url === prepared.urls.updaterEndpoint) return { status: 204, headers: {}, body: Buffer.alloc(0) };
      if (url === prepared.urls.stableManual) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url === 'https://coordinar.io/updates/releases/version') {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            version: '0.0.1-beta.5',
            changelogUrl: 'https://coordinar.io/updates/releases/version',
          })),
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async head(url) {
      assert.equal(url, prepared.urls.stableManual);
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };

  const result = await rollbackDesktopBetaChannel(
    { expectedCurrentVersion: VERSION },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );
  assert.equal(result.removedVersion, VERSION);
  assert.equal(store.objects.has(prepared.pointerKey), false);
  const deletion = store.actions.find((action) => action.type === 'delete');
  assert.equal(deletion.metadata.ifMatch, priorEtag);
});

test('beta rollback refuses a current version different from the operator expectation', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore(storedReleaseEntries(prepared));

  await assert.rejects(
    rollbackDesktopBetaChannel(
      { expectedCurrentVersion: '0.0.1-beta.7' },
      { store, publicHttp: {}, updaterPublicKey: TEST_PUBLIC_KEY },
    ),
    /expected.*beta\.7.*beta\.6/i,
  );
  assert.equal(store.actions.some((action) => action.type === 'delete'), false);
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

test('S3 adapter returns object validators and applies all conditional pointer mutations', async () => {
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          Body: { async transformToByteArray() { return Uint8Array.from([1, 2, 3]); } },
          ETag: '"etag-v1"',
          VersionId: 'version-v1',
        };
      }
      if (command.constructor.name === 'PutObjectCommand') return { ETag: '"etag-v2"', VersionId: 'version-v2' };
      return { VersionId: 'version-v3' };
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
  assert.deepEqual(await store.getObject('desktop/releases/test'), {
    bytes: Buffer.from([1, 2, 3]),
    etag: '"etag-v1"',
    versionId: 'version-v1',
  });
  await store.putObject('desktop/releases/test', Buffer.from('immutable'), {
    immutable: true,
    contentType: 'application/octet-stream',
    cacheControl: 'immutable',
  });
  await store.putObject('desktop/channels/beta/latest.json', Buffer.from('{}'), {
    contentType: 'application/json',
    ifMatch: '"etag-v1"',
  });
  await store.deleteObject('desktop/channels/beta/latest.json', { ifMatch: '"etag-v2"' });

  assert.equal(commands[1].constructor.name, 'PutObjectCommand');
  assert.equal(commands[1].input.Bucket, 'kordi-releases');
  assert.equal(commands[1].input.IfNoneMatch, '*');
  assert.equal(commands[2].input.IfNoneMatch, undefined);
  assert.equal(commands[2].input.IfMatch, '"etag-v1"');
  assert.equal(commands[3].constructor.name, 'DeleteObjectCommand');
  assert.equal(commands[3].input.IfMatch, '"etag-v2"');
});
