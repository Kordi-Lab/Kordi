import {
  assert,
  readFile,
  rm,
  writeFile,
  join,
  test,
  assertAppBundleContract,
  createAdhocPreviewVerifier,
  createProductionVerifier,
  publishDesktopRelease,
  verifyTauriUpdaterSignature,
  VERSION,
  PUB_DATE,
  TEST_PUBLIC_KEY_TEXT,
  TEST_SIGNATURE,
  TEST_PUBLIC_KEY,
  APP_CONTRACT_BUNDLE,
  ACCEPTANCE_ENDPOINT,
  PRODUCTION_ENDPOINT,
  MACOS_NOTIFICATION_BUNDLE_MARKERS,
  contractRun,
  makeVerifierRepoFixture,
  artifactVerifierRun,
  makeFixture,
  optionsFor,
  passingVerifier,
  MemoryStore,
  preparedFixture,
} from './test_support/publishDesktopReleaseFixtures.mjs';
import { releaseNotesFromChangelog } from './lib/desktop-release-notes.mjs';

test('generates deterministic beta.6 metadata, keys, checksums, and product URLs', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const first = await preparedFixture(fixture);
  const second = await preparedFixture(fixture);

  assert.deepEqual(first.release, second.release);
  assert.deepEqual(first.pointer, second.pointer);
  assert.equal(first.release.version, VERSION);
  assert.equal(first.release.pubDate, PUB_DATE);
  assert.match(first.release.notes, /^### (?:Added|Changed|Fixed)$/m);
  assert.match(first.release.notes, /^- /m);
  assert.equal(first.release.manual.objectKey, `desktop/releases/${VERSION}/macos/aarch64/${fixture.dmgName}`);
  assert.equal(first.release.platforms['darwin-aarch64'].objectKey, `desktop/releases/${VERSION}/macos/aarch64/Kordi.app.tar.gz`);
  assert.equal(first.pointerKey, 'desktop/channels/beta/latest.json');
  assert.equal(first.pointer.releaseManifestKey, `desktop/releases/${VERSION}/release.json`);
  assert.equal(first.urls.manual, `https://kordi.ai/updates/releases/${VERSION}/${fixture.dmgName}`);
  assert.equal(first.urls.updaterArchive, `https://kordi.ai/updates/releases/${VERSION}/Kordi.app.tar.gz`);
  assert.equal(first.urls.updaterEndpoint, 'https://kordi.ai/updates/desktop/darwin/aarch64/0.0.0');
  assert.match(first.checksumsBytes.toString(), new RegExp(`${first.artifacts.manual.sha256}  macos/aarch64/${fixture.dmgName}`));
  assert.match(first.checksumsBytes.toString(), new RegExp(`${first.artifacts.updater.sha256}  macos/aarch64/Kordi\\.app\\.tar\\.gz`));
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'release.json')), first.releaseBytes);
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'checksums.sha256')), first.checksumsBytes);
  assert.deepEqual(await readFile(join(fixture.releaseDir, 'channel-beta-latest.json')), first.pointerBytes);
});

test('accepts a corrective beta suffix in metadata and immutable object keys', async (t) => {
  const version = '0.0.1-beta.19.1';
  const fixture = await makeFixture(version);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const prepared = await preparedFixture(fixture, { version });

  assert.equal(prepared.release.version, version);
  assert.equal(prepared.pointer.releaseManifestKey, `desktop/releases/${version}/release.json`);
  assert.ok(prepared.immutableObjects.every(({ key }) => key.includes(`/releases/${version}/`)));
});

test('extracts the exact classified changelog entry and rejects missing release notes', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.3-beta.4] - 2026-08-08',
    '',
    '### Added',
    '',
    '- Added a focused first-launch summary.',
    '',
    '### Fixed',
    '',
    '- Kept startup available when metadata cannot load.',
    '',
    '## [1.2.3-beta.3] - 2026-08-01',
    '',
    '- Older notes.',
  ].join('\n');

  assert.equal(
    releaseNotesFromChangelog(changelog, '1.2.3-beta.4'),
    [
      '### Added',
      '',
      '- Added a focused first-launch summary.',
      '',
      '### Fixed',
      '',
      '- Kept startup available when metadata cannot load.',
    ].join('\n'),
  );
  assert.throws(
    () => releaseNotesFromChangelog(changelog, '1.2.3-beta.5'),
    /does not contain classified release notes/,
  );

  const correctiveChangelog = changelog.replaceAll('1.2.3-beta.4', '1.2.3-beta.19.1');
  assert.match(
    releaseNotesFromChangelog(correctiveChangelog, '1.2.3-beta.19.1'),
    /Added a focused first-launch summary/,
  );
  assert.throws(
    () => releaseNotesFromChangelog(correctiveChangelog, '1.2.3-beta.19.01'),
    /beta semantic version/,
  );
});

test('ad-hoc publication is legal only on acceptance and fails before storage', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const [releaseProfile, channel] of [
    ['adhoc-preview', 'beta'],
    ['unsigned', 'acceptance'],
  ]) {
    const store = new MemoryStore();
    await assert.rejects(
      publishDesktopRelease(optionsFor(fixture, { releaseProfile, channel }), {
        verifier: passingVerifier(), store, publicHttp: {},
      }),
      /release profile|ad-hoc preview.*acceptance/i,
    );
    assert.deepEqual(store.actions, []);
  }
});

test('ad-hoc metadata is unmistakably preview-only', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await preparedFixture(fixture, {
    releaseProfile: 'adhoc-preview',
    channel: 'acceptance',
  });
  assert.equal(prepared.releaseProfile, 'adhoc-preview');
  assert.equal(prepared.release.notes, `Kordi ${VERSION} ad-hoc external-test preview`);
  assert.equal(
    prepared.release.changelogUrl,
    'https://github.com/Kordi-AI/Kordi/commit/0123456789abcdef0123456789abcdef01234567',
  );
  assert.equal(prepared.pointerKey, 'desktop/channels/acceptance/latest.json');
  assert.equal(Object.hasOwn(prepared.release, 'releaseProfile'), false);
});

test('cryptographically verifies Tauri minisign metadata and rejects changed bytes', () => {
  const publicKey = Buffer.from(TEST_PUBLIC_KEY_TEXT).toString('base64');
  assert.doesNotThrow(() => verifyTauriUpdaterSignature(Buffer.from('test'), TEST_SIGNATURE, publicKey));
  assert.throws(
    () => verifyTauriUpdaterSignature(Buffer.from('changed'), TEST_SIGNATURE, publicKey),
    /signature verification failed/i,
  );
});

test('application bundle contract enforces the ad-hoc profile in exact command order', () => {
  const calls = [];
  assert.doesNotThrow(() => assertAppBundleContract(
    contractRun(new Map(), calls),
    APP_CONTRACT_BUNDLE,
    {
      version: VERSION,
      identifier: 'io.kordi.cloud',
      releaseProfile: 'adhoc-preview',
    },
  ));
  assert.deepEqual(calls, [
    `plutil -extract CFBundleShortVersionString raw -o - ${APP_CONTRACT_BUNDLE}/Contents/Info.plist`,
    `plutil -extract CFBundleIdentifier raw -o - ${APP_CONTRACT_BUNDLE}/Contents/Info.plist`,
    `codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`,
    `codesign --display --verbose=4 ${APP_CONTRACT_BUNDLE}`,
    `spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`,
    [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '),
    [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '),
    ...MACOS_NOTIFICATION_BUNDLE_MARKERS.map((marker) => [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      marker, APP_CONTRACT_BUNDLE,
    ].join(' ')),
  ]);
});

test('application bundle contract preserves the production Gatekeeper and endpoint checks', () => {
  const calls = [];
  const productionRun = contractRun(new Map([
    [`spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`, {
      status: 0, stdout: '', stderr: '',
    }],
    [[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '), {
      status: 0,
      stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`,
      stderr: '',
    }],
    [[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '), {
      status: 1,
      stdout: '',
      stderr: '',
    }],
  ]), calls);

  assert.doesNotThrow(() => assertAppBundleContract(
    productionRun,
    APP_CONTRACT_BUNDLE,
    {
      version: VERSION,
      identifier: 'io.kordi.cloud',
      releaseProfile: 'production',
    },
  ));
  assert.deepEqual(calls, [
    `plutil -extract CFBundleShortVersionString raw -o - ${APP_CONTRACT_BUNDLE}/Contents/Info.plist`,
    `plutil -extract CFBundleIdentifier raw -o - ${APP_CONTRACT_BUNDLE}/Contents/Info.plist`,
    `codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`,
    `spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`,
    [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '),
    [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE,
    ].join(' '),
    ...MACOS_NOTIFICATION_BUNDLE_MARKERS.map((marker) => [
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      marker, APP_CONTRACT_BUNDLE,
    ].join(' ')),
  ]);
});

test('application bundle contract rejects mixed updater endpoints for both profiles', () => {
  for (const releaseProfile of ['adhoc-preview', 'production']) {
    const mixedEndpoints = new Map([
      [`spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`, {
        status: releaseProfile === 'production' ? 0 : 1,
        stdout: '',
        stderr: releaseProfile === 'production' ? '' : 'rejected',
      }],
      [[
        'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
        ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE,
      ].join(' '), {
        status: 0, stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`, stderr: '',
      }],
      [[
        'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
        PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
      ].join(' '), {
        status: 0, stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`, stderr: '',
      }],
    ]);

    assert.throws(
      () => assertAppBundleContract(contractRun(mixedEndpoints), APP_CONTRACT_BUNDLE, {
        version: VERSION,
        identifier: 'io.kordi.cloud',
        releaseProfile,
      }),
      /profile isolation|updater endpoint/i,
      releaseProfile,
    );
  }
});

test('application bundle contract fails closed when the forbidden endpoint scan cannot run', () => {
  const forbiddenCommand = [
    'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
    PRODUCTION_ENDPOINT, APP_CONTRACT_BUNDLE,
  ].join(' ');
  assert.throws(
    () => assertAppBundleContract(contractRun(new Map([[forbiddenCommand, {
      status: 2, stdout: '', stderr: 'inspection error',
    }]])), APP_CONTRACT_BUNDLE, {
      version: VERSION,
      identifier: 'io.kordi.cloud',
      releaseProfile: 'adhoc-preview',
    }),
    /inspect.*updater endpoint|profile isolation/i,
  );
});

test('application bundle contract rejects every preview contract mismatch', () => {
  const info = `${APP_CONTRACT_BUNDLE}/Contents/Info.plist`;
  const rejectionCases = [
    [
      'wrong version',
      new Map([[`plutil -extract CFBundleShortVersionString raw -o - ${info}`, {
        status: 0, stdout: '0.0.1-beta.5.1\n', stderr: '',
      }]]),
      /version does not match/i,
    ],
    [
      'wrong identifier',
      new Map([[`plutil -extract CFBundleIdentifier raw -o - ${info}`, {
        status: 0, stdout: 'io.kordi.desktop\n', stderr: '',
      }]]),
      /identifier/i,
    ],
    [
      'normal endpoint',
      new Map([[['rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
        ACCEPTANCE_ENDPOINT, APP_CONTRACT_BUNDLE].join(' '), {
        status: 1, stdout: '', stderr: '',
      }]]),
      /updater endpoint/i,
    ],
    [
      'Developer ID authority',
      new Map([[`codesign --display --verbose=4 ${APP_CONTRACT_BUNDLE}`, {
        status: 0,
        stdout: '',
        stderr: 'Signature=adhoc\nAuthority=Developer ID Application: Example\nTeamIdentifier=not set\n',
      }]]),
      /identity-free ad-hoc/i,
    ],
    [
      'invalid code signature',
      new Map([[`codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`, {
        status: 1, stdout: '', stderr: 'invalid',
      }]]),
      /codesign verification failed/i,
    ],
    [
      'missing notification permission command',
      new Map([[[
        'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
        'desktop_request_notification_permission', APP_CONTRACT_BUNDLE,
      ].join(' '), {
        status: 1, stdout: '', stderr: '',
      }]]),
      /native notification integration/i,
    ],
  ];

  for (const [name, overrides, expected] of rejectionCases) {
    assert.throws(
      () => assertAppBundleContract(contractRun(overrides), APP_CONTRACT_BUNDLE, {
        version: VERSION,
        identifier: 'io.kordi.cloud',
        releaseProfile: 'adhoc-preview',
      }),
      expected,
      name,
    );
  }
});

test('profile-aware verifiers apply one bundle contract to every artifact copy', async (t) => {
  for (const releaseProfile of ['production', 'adhoc-preview']) {
    await t.test(releaseProfile, async (t) => {
      const repoRoot = await makeVerifierRepoFixture();
      t.after(() => rm(repoRoot, { recursive: true, force: true }));
      const calls = [];
      const run = artifactVerifierRun(releaseProfile, calls);
      const options = {
        repoRoot,
        run,
        env: {
          TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'updater-password',
        },
        async inspectUpdaterArchiveImpl(receivedRun, updaterPath, version, verifyBundle) {
          assert.equal(receivedRun, run);
          assert.equal(updaterPath, '/tmp/Kordi.app.tar.gz');
          assert.equal(version, VERSION);
          calls.push('[inspect updater archive]');
          verifyBundle('/tmp/archive/Kordi.app');
        },
        mountDmgImpl(manualPath) {
          assert.equal(manualPath, '/tmp/Kordi.dmg');
          calls.push('[mount dmg]');
          return { device: '/dev/disk-test', mountPoint: '/tmp/mounted-kordi' };
        },
        validateDmgVolumeLayoutImpl(mountPoint, contract) {
          assert.equal(mountPoint, '/tmp/mounted-kordi');
          assert.deepEqual(contract, { appName: 'Kordi' });
          calls.push('[validate dmg layout]');
        },
        detachDmgImpl(device) {
          assert.equal(device, '/dev/disk-test');
          calls.push('[detach dmg]');
        },
      };
      const verifier = releaseProfile === 'production'
        ? createProductionVerifier(options)
        : createAdhocPreviewVerifier(options);

      await verifier.verify({
        version: VERSION,
        expectedCommit: '0123456789abcdef0123456789abcdef01234567',
        appBundle: '/tmp/top/Kordi.app',
        updaterPath: '/tmp/Kordi.app.tar.gz',
        updaterBytes: Buffer.from('test'),
        signature: TEST_SIGNATURE,
        updaterPublicKey: TEST_PUBLIC_KEY,
        manualPath: '/tmp/Kordi.dmg',
      });

      const count = (pattern) => calls.filter((command) => pattern.test(command)).length;
      assert.equal(count(/^security find-identity /), releaseProfile === 'production' ? 1 : 0);
      assert.equal(count(/^plutil -extract CFBundleShortVersionString /), 3);
      assert.equal(count(/^plutil -extract CFBundleIdentifier /), 3);
      assert.equal(count(/^codesign --verify /), 3);
      assert.equal(count(/^codesign --display /), releaseProfile === 'adhoc-preview' ? 3 : 0);
      assert.equal(count(/^spctl --assess /), 3);
      const expectedEndpoint = releaseProfile === 'adhoc-preview'
        ? ACCEPTANCE_ENDPOINT
        : PRODUCTION_ENDPOINT;
      const forbiddenEndpoint = releaseProfile === 'adhoc-preview'
        ? PRODUCTION_ENDPOINT
        : ACCEPTANCE_ENDPOINT;
      assert.equal(calls.filter((command) => command.includes(` -F ${expectedEndpoint} `)).length, 3);
      assert.equal(calls.filter((command) => command.includes(` -F ${forbiddenEndpoint} `)).length, 3);
      for (const marker of MACOS_NOTIFICATION_BUNDLE_MARKERS) {
        assert.equal(calls.filter((command) => command.includes(` -F ${marker} `)).length, 3);
      }
      assert.equal(calls.filter((command) => command.startsWith('rg ') && command.includes(' -n ')).length, 4);
      assert.ok(calls.indexOf('[inspect updater archive]') > calls.findIndex((command) => command.startsWith('codesign ')));
      assert.ok(calls.indexOf('[mount dmg]') > calls.indexOf('[inspect updater archive]'));
      assert.ok(calls.indexOf('[validate dmg layout]') > calls.indexOf('[mount dmg]'));
      assert.ok(calls.indexOf('[detach dmg]') > calls.indexOf('[validate dmg layout]'));
      assert.equal(calls.at(-1), '[detach dmg]');
    });
  }
});

test('ad-hoc verifier rejects a changed acceptance overlay before artifact inspection', async (t) => {
  const repoRoot = await makeVerifierRepoFixture();
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(
    join(repoRoot, 'app', 'desktop', 'src-tauri', 'tauri.cloud.acceptance.conf.json'),
    JSON.stringify({
      productName: 'Kordi',
      identifier: 'io.kordi.cloud',
      bundle: { macOS: { signingIdentity: '-' } },
      plugins: { updater: { endpoints: [PRODUCTION_ENDPOINT] } },
    }),
  );
  const calls = [];
  const verifier = createAdhocPreviewVerifier({
    repoRoot,
    run: artifactVerifierRun('adhoc-preview', calls),
    env: {
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'updater-password',
    },
  });

  await assert.rejects(
    verifier.verify({
      version: VERSION,
      expectedCommit: '0123456789abcdef0123456789abcdef01234567',
      appBundle: '/tmp/top/Kordi.app',
      updaterPath: '/tmp/Kordi.app.tar.gz',
      updaterBytes: Buffer.from('test'),
      signature: TEST_SIGNATURE,
      updaterPublicKey: TEST_PUBLIC_KEY,
      manualPath: '/tmp/Kordi.dmg',
    }),
    /Acceptance Tauri configuration does not match the ad-hoc preview contract/i,
  );
  assert.equal(calls.some((command) => command.startsWith('codesign ')), false);
});
