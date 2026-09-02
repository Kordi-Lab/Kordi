import {
  assert,
  rm,
  test,
  publishDesktopRelease,
  PREVIOUS_VERSION,
  TEST_PUBLIC_KEY,
  makeFixture,
  optionsFor,
  passingVerifier,
  MemoryStore,
  makePublicHttp,
  storedReleaseEntries,
  preparedFixture,
} from './test_support/publishDesktopReleaseFixtures.mjs';

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

test('publisher reads a corrective beta prior pointer before promotion', async (t) => {
  const version = '0.0.1-beta.19.2';
  const previousVersion = '0.0.1-beta.19.1';
  const fixture = await makeFixture(version);
  const previousFixture = await makeFixture(previousVersion);
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(previousFixture.root, { recursive: true, force: true }),
  ]));
  const prepared = await preparedFixture(fixture, { version });
  const previous = await preparedFixture(previousFixture, { version: previousVersion });
  const store = new MemoryStore(storedReleaseEntries(previous));

  const result = await publishDesktopRelease(optionsFor(fixture, { version }), {
    verifier: passingVerifier(),
    updaterPublicKey: TEST_PUBLIC_KEY,
    store,
    publicHttp: makePublicHttp(prepared),
  });

  assert.equal(result.published, true);
  assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
});

test('beta stable DMG accepts a no-store CDN miss without weakening byte checks', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();

  const result = await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store,
    publicHttp: makePublicHttp(prepared, { stableCdnStatus: 'miss' }),
  });

  assert.equal(result.published, true);
  assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
});

test('promotion waits through the full public pointer convergence window before rollback', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();
  const baseHttp = makePublicHttp(prepared);
  let attempts = 0;
  let waits = 0;
  const publicHttp = {
    head: (...args) => baseHttp.head(...args),
    async get(url, options) {
      if (url === prepared.urls.updaterEndpoint && attempts++ < 9) {
        return { status: 503, headers: {}, body: Buffer.from('not converged') };
      }
      return baseHttp.get(url, options);
    },
    async waitForPropagation() { waits += 1; },
  };

  const result = await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store,
    publicHttp,
  });

  assert.equal(result.published, true);
  assert.equal(attempts, 10);
  assert.equal(waits, 9);
  assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
  assert.equal(
    store.actions.filter((action) => action.type === 'put' && action.key === prepared.pointerKey).length,
    1,
  );
});

test('failed first promotion atomically replaces the pointer with an unpublished tombstone', async (t) => {
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
  assert.deepEqual(JSON.parse(store.bytes(prepared.pointerKey)), {
    schemaVersion: 1,
    channel: 'beta',
    unpublished: true,
  });
  const pointerWrites = store.actions.filter((action) => action.type === 'put' && action.key === prepared.pointerKey);
  assert.equal(pointerWrites.length, 2);
  assert.equal(pointerWrites[1].metadata.ifMatch, pointerWrites[0].resultEtag);
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
  };
  const baseHttp = makePublicHttp(prepared);
  const publicHttp = {
    async head(url) {
      const unpublished = JSON.parse(baseStore.bytes(prepared.pointerKey) ?? 'null')?.unpublished === true;
      if (url === prepared.urls.stableManual && unpublished) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      return baseHttp.head(url);
    },
    async get(url, options) {
      const unpublished = JSON.parse(baseStore.bytes(prepared.pointerKey) ?? 'null')?.unpublished === true;
      if (unpublished) {
        if (url === prepared.urls.updaterEndpoint) return { status: 204, headers: {}, body: Buffer.alloc(0) };
        if (url === prepared.urls.stableManual) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        if (url === 'https://kordi.ai/updates/releases/version') {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({
              version: '0.0.1-beta.5',
              changelogUrl: 'https://kordi.ai/updates/releases/version',
            })),
          };
        }
      }
      return baseHttp.get(url, options);
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
  assert.equal(JSON.parse(baseStore.bytes(prepared.pointerKey)).unpublished, true);
  const writes = baseStore.actions.filter((action) => action.type === 'put' && action.key === prepared.pointerKey);
  assert.equal(writes[1].metadata.ifMatch, writes[0].resultEtag);
});

test('promotion reconciles a committed write when MinIO loses the success response', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const baseStore = new MemoryStore();
  let losePromotionResponse = true;
  const store = {
    getObject: (key) => baseStore.getObject(key),
    async putObject(key, bytes, metadata) {
      const result = await baseStore.putObject(key, bytes, metadata);
      if (key === prepared.pointerKey && losePromotionResponse) {
        losePromotionResponse = false;
        throw new Error('simulated committed write with lost response');
      }
      return result;
    },
  };

  const result = await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store,
    publicHttp: makePublicHttp(prepared),
  });

  assert.equal(result.published, true);
  assert.deepEqual(baseStore.bytes(prepared.pointerKey), prepared.pointerBytes);
});

test('promotion retries an unchanged pre-commit failure and reconciles an ETag-less success', async (t) => {
  for (const mode of ['pre-commit-throw', 'etagless-success']) {
    await t.test(mode, async (t) => {
      const fixture = await makeFixture();
      t.after(() => rm(fixture.root, { recursive: true, force: true }));
      const prepared = await preparedFixture(fixture);
      const baseStore = new MemoryStore();
      let firstPointerWrite = true;
      const store = {
        getObject: (key) => baseStore.getObject(key),
        async putObject(key, bytes, metadata) {
          if (key === prepared.pointerKey && firstPointerWrite) {
            firstPointerWrite = false;
            if (mode === 'pre-commit-throw') {
              throw new Error('simulated request failure before storage commit');
            }
            await baseStore.putObject(key, bytes, metadata);
            return { etag: null, versionId: null };
          }
          return baseStore.putObject(key, bytes, metadata);
        },
      };

      const result = await publishDesktopRelease(optionsFor(fixture), {
        verifier: passingVerifier(),
        store,
        publicHttp: makePublicHttp(prepared),
      });

      assert.equal(result.published, true);
      assert.deepEqual(baseStore.bytes(prepared.pointerKey), prepared.pointerBytes);
    });
  }
});

test('failed verification reconciles a committed restore with a lost response', async (t) => {
  const fixture = await makeFixture();
  const previousFixture = await makeFixture(PREVIOUS_VERSION);
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(previousFixture.root, { recursive: true, force: true }),
  ]));
  const prepared = await preparedFixture(fixture);
  const previous = await preparedFixture(previousFixture, { version: PREVIOUS_VERSION });
  const baseStore = new MemoryStore(storedReleaseEntries(previous));
  let pointerWrites = 0;
  const store = {
    getObject: (key) => baseStore.getObject(key),
    async putObject(key, bytes, metadata) {
      const result = await baseStore.putObject(key, bytes, metadata);
      if (key === prepared.pointerKey && (pointerWrites += 1) === 2) {
        throw new Error('simulated committed restore with lost response');
      }
      return result;
    },
  };

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      updaterPublicKey: TEST_PUBLIC_KEY,
      store,
      publicHttp: makePublicHttp(prepared, {
        failPostPromotion: true,
        previousPrepared: previous,
      }),
    }),
    (error) => /post-promotion|updater endpoint/i.test(error.message)
      && !/rollback also failed/i.test(error.message),
  );
  assert.deepEqual(baseStore.bytes(prepared.pointerKey), previous.pointerBytes);
});

test('ambiguous promotion never overwrites a third concurrent pointer state', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const baseStore = new MemoryStore();
  const concurrentPointer = Buffer.from('{"newer":"publisher"}\n');
  let losePromotionResponse = true;
  const store = {
    getObject: (key) => baseStore.getObject(key),
    async putObject(key, bytes, metadata) {
      const result = await baseStore.putObject(key, bytes, metadata);
      if (key === prepared.pointerKey && losePromotionResponse) {
        losePromotionResponse = false;
        baseStore.forcePut(key, concurrentPointer);
        throw new Error('simulated ambiguous promotion response');
      }
      return result;
    },
  };

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp: makePublicHttp(prepared),
    }),
    /concurrent|reconcile|changed/i,
  );
  assert.deepEqual(baseStore.bytes(prepared.pointerKey), concurrentPointer);
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

test('publisher rejects every malformed tombstone before mutating the channel pointer', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const malformed = [
    null,
    [],
    { schemaVersion: 1, channel: 'beta', unpublished: false },
    { schemaVersion: 1, channel: 'acceptance', unpublished: true },
    { schemaVersion: 1, channel: 'beta', unpublished: true, extra: 1 },
    {
      schemaVersion: 1,
      channel: 'beta',
      unpublished: true,
      releaseManifestKey: prepared.pointer.releaseManifestKey,
      releaseManifestSha256: prepared.pointer.releaseManifestSha256,
    },
  ];

  for (const value of malformed) {
    const store = new MemoryStore([
      ...storedReleaseEntries(prepared, { includePointer: false }),
      [prepared.pointerKey, Buffer.from(`${JSON.stringify(value)}\n`)],
    ]);
    await assert.rejects(
      publishDesktopRelease(optionsFor(fixture), {
        verifier: passingVerifier(),
        store,
        publicHttp: makePublicHttp(prepared),
      }),
      /channel pointer.*object|unpublished channel pointer|invalid schema/i,
    );
    assert.equal(
      store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey),
      false,
    );
  }
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
