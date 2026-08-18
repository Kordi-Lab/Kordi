import {
  assert,
  rm,
  test,
  clearDesktopReleaseChannel,
  rollbackDesktopBetaChannel,
  VERSION,
  TEST_PUBLIC_KEY,
  makeFixture,
  MemoryStore,
  storedReleaseEntries,
  tombstoneBytes,
  preparedFixture,
} from './test_support/publishDesktopReleaseFixtures.mjs';

test('acceptance cleanup conditionally writes an unpublished tombstone and verifies 204', async (t) => {
  const version = '0.0.1-beta.13-preview.1';
  const fixture = await makeFixture(version);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, { channel: 'acceptance', version });
  const store = new MemoryStore(storedReleaseEntries(prepared));
  const priorEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;
  const updaterEndpoints = new Set([
    prepared.urls.updaterEndpoint,
    prepared.legacyUrls.updaterEndpoint,
  ]);
  const publicHttp = {
    async get(url) {
      assert.equal(updaterEndpoints.has(url), true);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    },
    async head() { throw new Error('acceptance cleanup must not read beta stable assets'); },
  };

  const result = await clearDesktopReleaseChannel(
    { channel: 'acceptance' },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );

  assert.equal(result.removed, true);
  assert.deepEqual(JSON.parse(store.bytes(prepared.pointerKey)), {
    schemaVersion: 1,
    channel: 'acceptance',
    unpublished: true,
  });
  const cleanupWrite = store.actions.find((action) => action.type === 'put');
  assert.equal(cleanupWrite.metadata.ifMatch, priorEtag);
});

test('acceptance cleanup reconciles a committed tombstone when its response is lost', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, { channel: 'acceptance' });
  const baseStore = new MemoryStore(storedReleaseEntries(prepared));
  let loseCleanupResponse = true;
  const store = {
    getObject: (key) => baseStore.getObject(key),
    async putObject(key, bytes, metadata) {
      const result = await baseStore.putObject(key, bytes, metadata);
      if (key === prepared.pointerKey && loseCleanupResponse) {
        loseCleanupResponse = false;
        throw new Error('simulated committed cleanup with lost response');
      }
      return result;
    },
  };
  const publicHttp = {
    async get() { return { status: 204, headers: {}, body: Buffer.alloc(0) }; },
    async head() { throw new Error('acceptance cleanup must not read beta stable assets'); },
  };

  const result = await clearDesktopReleaseChannel(
    { channel: 'acceptance' },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );

  assert.equal(result.removed, true);
  assert.equal(JSON.parse(baseStore.bytes(prepared.pointerKey)).unpublished, true);
});

test('acceptance cleanup is idempotent for an existing tombstone and still verifies 204', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, { channel: 'acceptance' });
  const store = new MemoryStore([[prepared.pointerKey, tombstoneBytes('acceptance')]]);
  let endpointReads = 0;
  const updaterEndpoints = new Set([
    prepared.urls.updaterEndpoint,
    prepared.legacyUrls.updaterEndpoint,
  ]);
  const publicHttp = {
    async get(url) {
      assert.equal(updaterEndpoints.has(url), true);
      endpointReads += 1;
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    },
    async head() { throw new Error('acceptance cleanup must not read beta stable assets'); },
  };

  const result = await clearDesktopReleaseChannel(
    { channel: 'acceptance' },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );

  assert.deepEqual(result, { channel: 'acceptance', removed: false });
  assert.equal(endpointReads, 2);
  assert.equal(store.actions.some((action) => action.type === 'put'), false);
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
  const mutations = store.actions.filter((action) => action.type === 'put');
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].metadata.ifMatch, mutations[0].resultEtag);
  assert.equal(endpointReads, 2);
});

test('beta rollback tombstones only the expected current release and verifies safe fallback', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore(storedReleaseEntries(prepared));
  const priorEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;
  const publicUrlSets = [prepared.urls, prepared.legacyUrls];
  const updaterEndpoints = new Set(publicUrlSets.map((urls) => urls.updaterEndpoint));
  const stableManualUrls = new Set(publicUrlSets.map((urls) => urls.stableManual));
  const legacyMetadataUrls = new Set([
    'https://kordi.ai/updates/releases/version',
    'https://coordinar.io/updates/releases/version',
  ]);
  const publicHttp = {
    async get(url) {
      if (updaterEndpoints.has(url)) return { status: 204, headers: {}, body: Buffer.alloc(0) };
      if (stableManualUrls.has(url)) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (legacyMetadataUrls.has(url)) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            version: '0.0.1-beta.5',
            changelogUrl: 'https://kordi.ai/updates/releases/version',
          })),
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async head(url) {
      assert.equal(stableManualUrls.has(url), true);
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  };

  const result = await rollbackDesktopBetaChannel(
    { expectedCurrentVersion: VERSION },
    { store, publicHttp, updaterPublicKey: TEST_PUBLIC_KEY },
  );
  assert.equal(result.removedVersion, VERSION);
  assert.deepEqual(JSON.parse(store.bytes(prepared.pointerKey)), {
    schemaVersion: 1,
    channel: 'beta',
    unpublished: true,
  });
  const rollbackWrite = store.actions.find((action) => action.type === 'put');
  assert.equal(rollbackWrite.metadata.ifMatch, priorEtag);
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
  assert.equal(store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey), false);
});
