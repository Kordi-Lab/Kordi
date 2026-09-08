import {
  assert, rm, test, publishDesktopRelease, clearDesktopReleaseChannel,
  rollbackDesktopBetaChannel, TEST_PUBLIC_KEY, makeFixture, optionsFor,
  passingVerifier, MemoryStore, makePublicHttp, storedReleaseEntries, preparedFixture,
} from './test_support/publishDesktopReleaseFixtures.mjs';
import { releaseNotesFromChangelog } from './lib/desktop-release-notes.mjs';

async function fixtureFor(t, version) {
  const fixture = await makeFixture(version);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  return fixture;
}

test('stable dry run prepares exact metadata without accessing storage or public URLs', async (t) => {
  const version = '0.0.1';
  const fixture = await fixtureFor(t, version);
  const store = new MemoryStore();
  const notes = releaseNotesFromChangelog([
    '## [0.0.1] - 2026-09-08', '', '### Added', '', '- Added stable updates.', '',
    '## [0.0.1-beta.19.3] - 2026-09-02', '', '### Fixed', '', '- Older beta notes.',
  ].join('\n'), version);
  const result = await publishDesktopRelease(optionsFor(fixture, {
    version, dryRun: true, releaseNotes: notes,
  }), { verifier: passingVerifier(), store, publicHttp: {} });

  assert.equal(result.published, false);
  assert.equal(result.release.version, version);
  assert.equal(result.release.notes, '### Added\n\n- Added stable updates.');
  assert.equal(result.release.changelogUrl, 'https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1');
  assert.equal(result.pointer.releaseManifestKey, 'desktop/releases/0.0.1/release.json');
  assert.equal(result.release.manual.fileName, 'Kordi_0.0.1_aarch64.dmg');
  assert.ok(result.immutableObjects.every(({ key }) => key.startsWith('desktop/releases/0.0.1/')));
  assert.deepEqual(store.actions, []);
});

test('malformed and unsupported versions fail before verification or storage', async (t) => {
  const fixture = await fixtureFor(t, '0.0.1');
  for (const version of [
    '00.0.1', '0.00.1', '0.0.01', '0.0', '0.0.1.2', 'v0.0.1',
    '0.0.1-rc.1', '0.0.1+build.43', '0.0.1-beta.01', '0.0.1-beta.1.01',
    '0.0.1-beta.1.2.3', '0.0.1/../../other',
  ]) {
    const store = new MemoryStore();
    const calls = [];
    await assert.rejects(publishDesktopRelease(optionsFor(fixture, { version }), {
      verifier: passingVerifier(calls), store, publicHttp: {},
    }), /stable or beta semantic version/);
    assert.deepEqual(calls, []);
    assert.deepEqual(store.actions, []);
    assert.throws(() => releaseNotesFromChangelog('', version), /stable or beta semantic version/);
  }
});

for (const [previousVersion, version] of [
  ['0.0.1-beta.19.3', '0.0.1'],
  ['0.0.1', '0.0.2'],
]) {
  test(`publishes ${version} after ${previousVersion} and preserves immutable objects`, async (t) => {
    const fixture = await fixtureFor(t, version);
    const previousFixture = await fixtureFor(t, previousVersion);
    const prepared = await preparedFixture(fixture, { version });
    const previous = await preparedFixture(previousFixture, { version: previousVersion });
    const store = new MemoryStore(storedReleaseEntries(previous));
    const dependencies = {
      verifier: passingVerifier(), updaterPublicKey: TEST_PUBLIC_KEY,
      store, publicHttp: makePublicHttp(prepared),
    };
    const result = await publishDesktopRelease(optionsFor(fixture, { version }), dependencies);
    assert.equal(result.published, true);
    assert.deepEqual(store.bytes(prepared.pointerKey), prepared.pointerBytes);
    for (const object of previous.immutableObjects) {
      assert.deepEqual(store.bytes(object.key), object.bytes);
    }
    // Reading the just-published stable pointer must also support an idempotent retry.
    store.actions.length = 0;
    await publishDesktopRelease(optionsFor(fixture, { version }), dependencies);
    assert.equal(store.actions.some(({ type, key }) => type === 'put' && key.includes('/releases/')), false);
  });
}

test('failed stable promotion restores and verifies the previous stable pointer', async (t) => {
  const version = '0.0.2';
  const fixture = await fixtureFor(t, version);
  const previousFixture = await fixtureFor(t, '0.0.1');
  const prepared = await preparedFixture(fixture, { version });
  const previous = await preparedFixture(previousFixture, { version: '0.0.1' });
  const store = new MemoryStore(storedReleaseEntries(previous));
  await assert.rejects(publishDesktopRelease(optionsFor(fixture, { version }), {
    verifier: passingVerifier(), updaterPublicKey: TEST_PUBLIC_KEY, store,
    publicHttp: makePublicHttp(prepared, { failPostPromotion: true, previousPrepared: previous }),
  }), /prior channel pointer was restored/);
  assert.deepEqual(store.bytes(prepared.pointerKey), previous.pointerBytes);
  const writes = store.actions.filter(({ type, key }) => type === 'put' && key === prepared.pointerKey);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].metadata.ifMatch, writes[0].resultEtag);
});

test('stable acceptance publication can be cleared without deleting immutable objects', async (t) => {
  const version = '0.0.1';
  const fixture = await fixtureFor(t, version);
  const options = optionsFor(fixture, { version, channel: 'acceptance' });
  const prepared = await preparedFixture(fixture, options);
  const store = new MemoryStore();
  await publishDesktopRelease(options, {
    verifier: passingVerifier(), store, publicHttp: makePublicHttp(prepared),
  });
  const result = await clearDesktopReleaseChannel({ channel: 'acceptance' }, {
    store, updaterPublicKey: TEST_PUBLIC_KEY,
    publicHttp: {
      async get(url) {
        assert.equal(url, prepared.urls.updaterEndpoint);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      },
      async head() { throw new Error('Acceptance cleanup must not request stable downloads'); },
    },
  });
  assert.equal(result.removed, true);
  assert.equal(JSON.parse(store.bytes(prepared.pointerKey)).unpublished, true);
  for (const object of prepared.immutableObjects) assert.deepEqual(store.bytes(object.key), object.bytes);
});

test('stable rollback checks the expected version and accepts a safe stable legacy fallback', async (t) => {
  const version = '0.0.2';
  const fixture = await fixtureFor(t, version);
  const prepared = await preparedFixture(fixture, { version });
  const store = new MemoryStore(storedReleaseEntries(prepared));
  await assert.rejects(rollbackDesktopBetaChannel({ expectedCurrentVersion: '0.0.1' }, {
    store, updaterPublicKey: TEST_PUBLIC_KEY, publicHttp: {},
  }), /Expected beta channel 0\.0\.1, but storage currently references 0\.0\.2/);
  assert.equal(store.actions.some(({ type }) => type === 'put'), false);
  const result = await rollbackDesktopBetaChannel({ expectedCurrentVersion: version }, {
    store, updaterPublicKey: TEST_PUBLIC_KEY,
    publicHttp: {
      async get(url) {
        if (url === prepared.urls.updaterEndpoint) return { status: 204, body: Buffer.alloc(0) };
        if (url === prepared.urls.stableManual) return { status: 404, body: Buffer.alloc(0) };
        assert.equal(url, 'https://kordi.ai/updates/releases/version');
        return { status: 200, body: Buffer.from(JSON.stringify({
          version: '0.0.1', changelogUrl: 'https://kordi.ai/updates/releases/version',
        })) };
      },
      async head(url) {
        assert.equal(url, prepared.urls.stableManual);
        return { status: 404, body: Buffer.alloc(0) };
      },
    },
  });
  assert.equal(result.removedVersion, version);
  assert.equal(JSON.parse(store.bytes(prepared.pointerKey)).unpublished, true);
  for (const object of prepared.immutableObjects) assert.deepEqual(store.bytes(object.key), object.bytes);
});
