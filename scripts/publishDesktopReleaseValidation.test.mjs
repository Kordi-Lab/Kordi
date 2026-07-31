import {
  assert,
  rm,
  writeFile,
  join,
  test,
  publishDesktopRelease,
  VERSION,
  TEST_PUBLIC_KEY,
  makeFixture,
  optionsFor,
  passingVerifier,
  MemoryStore,
  makePublicHttp,
  storedReleaseEntries,
  tombstoneBytes,
  preparedFixture,
} from './test_support/publishDesktopReleaseFixtures.mjs';

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
    publicHttp.actions.slice(0, 8).map(({ method, url }) => [method, url]),
    [
      ['HEAD', prepared.urls.manual],
      ['GET', prepared.urls.manual],
      ['HEAD', prepared.urls.updaterArchive],
      ['GET', prepared.urls.updaterArchive],
      ['HEAD', prepared.legacyUrls.manual],
      ['GET', prepared.legacyUrls.manual],
      ['HEAD', prepared.legacyUrls.updaterArchive],
      ['GET', prepared.legacyUrls.updaterArchive],
    ],
  );
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.urls.updaterEndpoint), true);
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.legacyUrls.updaterEndpoint), true);
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.urls.stableManual), true);
  assert.equal(publicHttp.actions.some(({ url }) => url === prepared.legacyUrls.stableManual), true);
});

test('publishing from a tombstone compares against its ETag instead of treating the key as absent', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore([
    ...storedReleaseEntries(prepared, { includePointer: false }),
    [prepared.pointerKey, tombstoneBytes('beta')],
  ]);
  const tombstoneEtag = (await store.getObject(prepared.pointerKey)).etag;
  store.actions.length = 0;

  await publishDesktopRelease(optionsFor(fixture), {
    verifier: passingVerifier(),
    store,
    publicHttp: makePublicHttp(prepared),
  });

  const promotion = store.actions.find(
    (action) => action.type === 'put' && action.key === prepared.pointerKey,
  );
  assert.equal(promotion.metadata.ifMatch, tombstoneEtag);
  assert.equal(promotion.metadata.ifNoneMatch, undefined);
  assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
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

test('a legacy-origin artifact failure prevents pointer promotion', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture);
  const store = new MemoryStore();
  const basePublicHttp = makePublicHttp(prepared);
  const publicHttp = {
    head: (url) => basePublicHttp.head(url),
    get(url) {
      if (url === prepared.legacyUrls.updaterArchive) {
        return Promise.resolve({ status: 503, headers: {}, body: Buffer.from('unavailable') });
      }
      return basePublicHttp.get(url);
    },
  };

  await assert.rejects(
    publishDesktopRelease(optionsFor(fixture), {
      verifier: passingVerifier(),
      store,
      publicHttp,
    }),
    /public get verification failed.*503/i,
  );
  assert.equal(
    store.actions.some((action) => action.type === 'put' && action.key === prepared.pointerKey),
    false,
  );
});
