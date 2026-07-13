# Kordi Beta.6 Ad-Hoc Acceptance Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver ad-hoc-signed Kordi `0.0.1-beta.6` to invited macOS arm64 testers through the acceptance updater without Apple credentials or any mutation of the normal beta channel.

**Architecture:** Two explicit Tauri flavor overlays build a manual beta.5.1 bootstrap and beta.6 acceptance target with macOS ad-hoc identity `-`, while the existing Tauri minisign key continues to authenticate updater archives. A shared macOS trust-policy module keeps Developer ID production verification unchanged and gives the publisher a fail-closed `adhoc-preview` profile that is legal only for `acceptance`. The existing MinIO catalog and product-domain routes remain unchanged; immutable beta.6 bytes are preview-only, and a future signed beta.7 migrates testers back to the normal beta endpoint.

**Tech Stack:** Tauri v2, macOS `codesign`/`spctl`, Node.js ESM and test runner, React/TypeScript, MinIO S3 API, GCP Secret Manager, GitHub CLI.

**Approved design:** `docs/superpowers/specs/2026-07-13-beta6-adhoc-acceptance-preview-design.md`

---

## File map

Create:

- `app/desktop/src-tauri/tauri.cloud.acceptance.conf.json` — beta.6 ad-hoc signing and acceptance-endpoint overlay.
- `app/desktop/src-tauri/tauri.cloud.acceptance-bootstrap.conf.json` — beta.5.1 bootstrap overlay.
- `scripts/lib/macos-release-signing.mjs` — reusable production and ad-hoc macOS trust checks.
- `scripts/macos-release-signing.test.mjs` — dependency-injected signing-policy tests.

Modify:

- `app/desktop/package.json` — dedicated acceptance target/bootstrap build commands.
- `app/desktop/tests/tauriUpdaterConfig.test.mjs` — parsed configuration and script contracts.
- `app/desktop/scripts/check-release-prerequisites.mjs` — explicit production/preview prerequisite profiles.
- `app/desktop/tests/releasePrerequisites.test.mjs` — production invariants and preview acceptance.
- `scripts/publish-desktop-release.mjs` — `--release-profile` CLI parsing.
- `scripts/lib/desktop-release.mjs` — profile validation, notes, verifier selection, and artifact contracts.
- `scripts/publish-desktop-release.test.mjs` — storage-before-failure, profile, notes, and artifact-verifier coverage.
- `app/desktop/src/features/updates/desktopUpdater.ts` — safe immutable manual URL and accurate verified-update wording.
- `app/desktop/tests/desktopUpdater.test.ts` — valid and hostile version fallback tests.
- `app/desktop/tests/desktopUpdaterSourceContract.test.mjs` — product-origin immutable fallback source contract.
- `app/desktop/src/pages/WorkspaceSidebar.tsx` — verified-update UI copy.
- `app/desktop/tests/desktopUpdateButton.test.tsx` — copy and integration contracts.
- `docs/release.md` — preview-only operator flow and beta.7 exit path.

The production Tauri config, Cloud update server, MinIO schema, normal beta pointer, stable download route, tag, and GitHub release flow do not change.

### Task 1: Add explicit ad-hoc acceptance build flavors

**Files:**

- Create: `app/desktop/src-tauri/tauri.cloud.acceptance.conf.json`
- Create: `app/desktop/src-tauri/tauri.cloud.acceptance-bootstrap.conf.json`
- Modify: `app/desktop/package.json`
- Test: `app/desktop/tests/tauriUpdaterConfig.test.mjs`

- [ ] **Step 1: Write the failing configuration contracts**

Extend `tauriUpdaterConfig.test.mjs` with exact flavor assertions:

```js
const acceptanceEndpoint =
  'https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';

test('acceptance flavors are ad-hoc, updater-signed, and isolated from beta', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  const cloud = readJson('src-tauri/tauri.cloud.conf.json');
  const target = readJson('src-tauri/tauri.cloud.acceptance.conf.json');
  const bootstrap = readJson('src-tauri/tauri.cloud.acceptance-bootstrap.conf.json');
  const pkg = readJson('package.json');

  assert.equal(base.version, '0.0.1-beta.6');
  assert.equal(base.bundle?.macOS?.signingIdentity, undefined);
  assert.deepEqual(base.plugins?.updater?.endpoints, [
    'https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
  ]);
  assert.equal(cloud.identifier, 'io.kordi.cloud');

  for (const flavor of [target, bootstrap]) {
    assert.equal(flavor.productName, 'Kordi');
    assert.equal(flavor.identifier, 'io.kordi.cloud');
    assert.equal(flavor.bundle?.macOS?.signingIdentity, '-');
    assert.deepEqual(flavor.plugins?.updater?.endpoints, [acceptanceEndpoint]);
    assert.equal(flavor.plugins?.updater?.pubkey, undefined);
  }
  assert.equal(target.version, undefined);
  assert.equal(bootstrap.version, '0.0.1-beta.5.1');
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-preview'], /tauri\.cloud\.acceptance\.conf\.json/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-bootstrap'], /tauri\.cloud\.acceptance-bootstrap\.conf\.json/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-preview'], /--bundles app,dmg/);
  assert.match(pkg.scripts['tauri:build:cloud:adhoc-bootstrap'], /--bundles app,dmg/);
});
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm --dir app/desktop exec node --test tests/tauriUpdaterConfig.test.mjs
```

Expected: FAIL with `ENOENT` for `tauri.cloud.acceptance.conf.json`.

- [ ] **Step 3: Add the two overlays**

Create `tauri.cloud.acceptance.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Kordi",
  "identifier": "io.kordi.cloud",
  "bundle": {
    "macOS": {
      "signingIdentity": "-"
    }
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

Create `tauri.cloud.acceptance-bootstrap.conf.json` with the same content plus the bootstrap version:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Kordi",
  "version": "0.0.1-beta.5.1",
  "identifier": "io.kordi.cloud",
  "bundle": {
    "macOS": {
      "signingIdentity": "-"
    }
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

- [ ] **Step 4: Add dedicated build scripts without touching production scripts**

Add these entries to `app/desktop/package.json`:

```json
"tauri:build:cloud:adhoc-preview": "pnpm release:secret-guard && pnpm tauri:prepare-sidecars && tauri build --config src-tauri/tauri.cloud.acceptance.conf.json --bundles app,dmg && pnpm release:verify-cloud-dmg",
"tauri:build:cloud:adhoc-bootstrap": "pnpm release:secret-guard && pnpm tauri:prepare-sidecars && tauri build --config src-tauri/tauri.cloud.acceptance-bootstrap.conf.json --bundles app,dmg && pnpm release:verify-cloud-dmg"
```

Do not edit `tauri:build:cloud:dmg`; it remains the production path.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --dir app/desktop exec node --test tests/tauriUpdaterConfig.test.mjs
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
git diff --check
git add app/desktop/package.json app/desktop/src-tauri/tauri.cloud.acceptance.conf.json app/desktop/src-tauri/tauri.cloud.acceptance-bootstrap.conf.json app/desktop/tests/tauriUpdaterConfig.test.mjs
git commit -m "build(desktop): add ad-hoc acceptance flavors"
```

Expected: both tests PASS and the commit changes only the four listed paths.

### Task 2: Introduce a reusable fail-closed macOS signing policy

**Files:**

- Create: `scripts/lib/macos-release-signing.mjs`
- Create: `scripts/macos-release-signing.test.mjs`
- Modify: `app/desktop/scripts/check-release-prerequisites.mjs`
- Test: `app/desktop/tests/releasePrerequisites.test.mjs`

- [ ] **Step 1: Write failing production and ad-hoc policy tests**

Create dependency-injected tests covering a production identity, production Gatekeeper rejection, valid ad-hoc metadata, ad-hoc `Authority=`, ad-hoc team identity, and invalid code signatures. Use these exact command keys:

```js
function ok(stdout = '', stderr = '') {
  return { status: 0, stdout, stderr };
}

function fail(stderr = 'command failed') {
  return { status: 1, stdout: '', stderr };
}

function fakeRun(results) {
  return (command, args = []) => {
    const key = [command, ...args].join(' ');
    return results.get(key) ?? fail(`unexpected command: ${key}`);
  };
}

const APP = '/tmp/Kordi.app';
const productionIdentity = '1) ABC "Developer ID Application: Example (TEAM123)"\n1 valid identities found';
const adhocDetails = [
  'Executable=/tmp/Kordi.app/Contents/MacOS/Kordi',
  'Identifier=io.kordi.cloud',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n');

test('production requires Developer ID, valid code, and Gatekeeper', () => {
  const run = fakeRun(new Map([
    ['security find-identity -v -p codesigning', ok(productionIdentity)],
    [`codesign --verify --deep --strict --verbose=2 ${APP}`, ok()],
    [`spctl --assess --type execute --verbose=2 ${APP}`, ok()],
  ]));
  assert.deepEqual(assertProductionSigningIdentity(run), { signingIdentityAvailable: true });
  assert.deepEqual(verifyMacAppSignature({ run, appBundle: APP, profile: 'production' }), {
    codesignVerified: true,
    gatekeeperVerified: true,
    signingKind: 'developer-id',
  });
});

test('ad-hoc accepts only identity-free ad-hoc metadata', () => {
  const run = fakeRun(new Map([
    [`codesign --verify --deep --strict --verbose=2 ${APP}`, ok()],
    [`codesign --display --verbose=4 ${APP}`, ok('', adhocDetails)],
    [`spctl --assess --type execute --verbose=2 ${APP}`, fail('rejected')],
  ]));
  assert.deepEqual(verifyMacAppSignature({ run, appBundle: APP, profile: 'adhoc-preview' }), {
    codesignVerified: true,
    gatekeeperVerified: false,
    signingKind: 'adhoc',
  });
});

test('production still fails closed when Gatekeeper rejects', () => {
  const run = fakeRun(new Map([
    [`codesign --verify --deep --strict --verbose=2 ${APP}`, ok()],
    [`spctl --assess --type execute --verbose=2 ${APP}`, fail('rejected')],
  ]));
  assert.throws(
    () => verifyMacAppSignature({ run, appBundle: APP, profile: 'production' }),
    /Gatekeeper assessment failed/i,
  );
});
```

Add the exact rejection loop:

```js
for (const details of [
  'Signature=adhoc\nAuthority=Developer ID Application: Example\nTeamIdentifier=not set',
  'Signature=adhoc\nTeamIdentifier=TEAM123',
  'TeamIdentifier=not set',
]) {
  const run = fakeRun(new Map([
    [`codesign --verify --deep --strict --verbose=2 ${APP}`, ok()],
    [`codesign --display --verbose=4 ${APP}`, ok('', details)],
  ]));
  assert.throws(
    () => verifyMacAppSignature({ run, appBundle: APP, profile: 'adhoc-preview' }),
    /identity-free ad-hoc signature/i,
  );
}
const invalid = fakeRun(new Map([
  [`codesign --verify --deep --strict --verbose=2 ${APP}`, fail('invalid')],
]));
assert.throws(
  () => verifyMacAppSignature({ run: invalid, appBundle: APP, profile: 'adhoc-preview' }),
  /codesign verification failed/i,
);
```

- [ ] **Step 2: Verify that the new module is missing**

Run:

```bash
node --test scripts/macos-release-signing.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/macos-release-signing.mjs`.

- [ ] **Step 3: Implement the focused signing-policy module**

Implement these exported contracts in `scripts/lib/macos-release-signing.mjs`:

```js
export const RELEASE_PROFILES = Object.freeze({
  PRODUCTION: 'production',
  ADHOC_PREVIEW: 'adhoc-preview',
});

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message);
  return result;
}

export function assertProductionSigningIdentity(run) {
  const result = requireSuccess(
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
    'Unable to inspect macOS signing identities',
  );
  const output = combinedOutput(result);
  const count = output.match(/(\d+) valid identities found/i);
  if (!/Developer ID Application:/i.test(output) || !count || Number(count[1]) < 1) {
    throw new Error('A valid Developer ID Application signing identity is required');
  }
  return { signingIdentityAvailable: true };
}

export function verifyMacAppSignature({ run, appBundle, profile }) {
  if (!Object.values(RELEASE_PROFILES).includes(profile)) {
    throw new Error('Release profile must be production or adhoc-preview');
  }
  requireSuccess(
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]),
    'codesign verification failed for the application bundle',
  );
  if (profile === RELEASE_PROFILES.PRODUCTION) {
    requireSuccess(
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle]),
      'Gatekeeper assessment failed for the application bundle',
    );
    return { codesignVerified: true, gatekeeperVerified: true, signingKind: 'developer-id' };
  }

  const display = requireSuccess(
    run('codesign', ['--display', '--verbose=4', appBundle]),
    'Unable to inspect the application code signature',
  );
  const details = combinedOutput(display);
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!/^Signature=adhoc$/m.test(details)
      || /^Authority=/m.test(details)
      || (team !== undefined && team !== 'not set')) {
    throw new Error('Application bundle must use an identity-free ad-hoc signature');
  }
  const gatekeeper = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle]);
  return {
    codesignVerified: true,
    gatekeeperVerified: gatekeeper.status === 0,
    signingKind: 'adhoc',
  };
}
```

The module must not execute commands itself; callers inject the runner so tests never alter security settings.

- [ ] **Step 4: Write failing prerequisite-profile tests**

Update every `releasePrerequisites.test.mjs` expected result so it includes the normalized `releaseProfile` (`production` for default and source-only calls). Add:

```js
test('ad-hoc preview requires updater keys but no Apple identity', () => {
  const deps = fakeDependencies({
    results: [
      [`codesign --display --verbose=4 ${APP}`, success('', 'Signature=adhoc\nTeamIdentifier=not set')],
      [`spctl --assess --type execute --verbose=2 ${APP}`, failure('rejected')],
    ],
  });
  const result = checkReleasePrerequisites({
    expectedCommit: COMMIT,
    appBundle: APP,
    releaseProfile: 'adhoc-preview',
  }, deps);
  assert.deepEqual(result, {
    commit: COMMIT,
    sourceOnly: false,
    releaseProfile: 'adhoc-preview',
    signingIdentityAvailable: false,
    codesignVerified: true,
    gatekeeperVerified: false,
  });
});

test('prerequisite CLI parses only explicit release profiles', () => {
  assert.deepEqual(parseReleasePrerequisiteArguments([
    '--release-profile', 'adhoc-preview', '--expected-commit', COMMIT, '--app-bundle', APP,
  ]), {
    sourceOnly: false,
    releaseProfile: 'adhoc-preview',
    expectedCommit: COMMIT,
    appBundle: APP,
  });
  assert.throws(
    () => parseReleasePrerequisiteArguments(['--release-profile', 'unsigned']),
    /production or adhoc-preview/i,
  );
});
```

Update the test helpers so `success(stdout = '', stderr = '')` preserves both streams.

- [ ] **Step 5: Refactor the prerequisite checker to use the shared policy**

Import `RELEASE_PROFILES`, `assertProductionSigningIdentity`, and `verifyMacAppSignature`. Normalize the profile before artifact checks:

```js
import {
  RELEASE_PROFILES,
  assertProductionSigningIdentity,
  verifyMacAppSignature,
} from '../../../scripts/lib/macos-release-signing.mjs';

const releaseProfile = options?.releaseProfile ?? RELEASE_PROFILES.PRODUCTION;
if (!Object.values(RELEASE_PROFILES).includes(releaseProfile)) {
  throw new Error('Release profile must be production or adhoc-preview');
}
```

Keep updater-key requirements for both artifact profiles. In production call `assertProductionSigningIdentity(run)` before `verifyMacAppSignature`. In preview skip identity discovery and call only the ad-hoc policy. Preserve `sourceOnly` behavior without claiming artifact trust. Extend the CLI parser with `--release-profile` and default it to `production`.

- [ ] **Step 6: Verify production remained fail-closed and commit**

Run:

```bash
node --test scripts/macos-release-signing.test.mjs
pnpm --dir app/desktop exec node --test tests/releasePrerequisites.test.mjs
git diff --check
git add scripts/lib/macos-release-signing.mjs scripts/macos-release-signing.test.mjs app/desktop/scripts/check-release-prerequisites.mjs app/desktop/tests/releasePrerequisites.test.mjs
git commit -m "build(release): add explicit ad-hoc trust policy"
```

Expected: tests PASS; production still rejects missing Developer ID and failed Gatekeeper, while preview never calls `security find-identity`.

### Task 3: Gate the publisher with an acceptance-only preview profile

**Files:**

- Modify: `scripts/publish-desktop-release.mjs`
- Modify: `scripts/lib/desktop-release.mjs`
- Test: `scripts/publish-desktop-release.test.mjs`

- [ ] **Step 1: Write failing CLI and pre-storage policy tests**

Update the parser contract to expect `releaseProfile: 'adhoc-preview'` when passed:

```js
'--release-profile', 'adhoc-preview',
```

Add these cases:

```js
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
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```bash
node --test --test-name-pattern='ad-hoc|publisher CLI' scripts/publish-desktop-release.test.mjs
```

Expected: FAIL because `releaseProfile` is not parsed or validated and notes still claim a normal release.

- [ ] **Step 3: Add profile parsing and validation**

Add `['--release-profile', 'releaseProfile']` to `VALUE_ARGUMENTS` and initialize parser options as:

```js
const options = { dryRun: false, releaseProfile: 'production' };
```

In `validateOptions`, enforce:

```js
const releaseProfile = options?.releaseProfile ?? 'production';
if (!['production', 'adhoc-preview'].includes(releaseProfile)) {
  throw new Error('Release profile must be production or adhoc-preview');
}
if (releaseProfile === 'adhoc-preview' && channel !== 'acceptance') {
  throw new Error('Ad-hoc preview releases may publish only to acceptance');
}
```

Return `releaseProfile` in the normalized options. Generate profile-specific human metadata:

```js
const notes = normalized.releaseProfile === 'adhoc-preview'
  ? `Kordi ${normalized.version} ad-hoc external-test preview`
  : `Kordi ${normalized.version}`;
const changelogUrl = normalized.releaseProfile === 'adhoc-preview'
  ? `https://github.com/Kordi-AI/Kordi/commit/${normalized.expectedCommit}`
  : `https://github.com/Kordi-AI/Kordi/releases/tag/V${normalized.version.replace(/-beta\./, '.beta')}`;
```

Use `notes` and `changelogUrl` in `release.json`; do not add fields that the strict Rust schema would reject.

- [ ] **Step 4: Write failing artifact-contract tests**

Export a focused `assertAppBundleContract` helper and test it with an injected command runner. Cover exact version, identifier, endpoint, and signing policy:

```js
const APP_CONTRACT_BUNDLE = '/tmp/Kordi.app';
const acceptanceEndpoint =
  'https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';

function contractRun(overrides = new Map()) {
  const info = `${APP_CONTRACT_BUNDLE}/Contents/Info.plist`;
  const results = new Map([
    [`plutil -extract CFBundleShortVersionString raw -o - ${info}`, { status: 0, stdout: `${VERSION}\n`, stderr: '' }],
    [`plutil -extract CFBundleIdentifier raw -o - ${info}`, { status: 0, stdout: 'io.kordi.cloud\n', stderr: '' }],
    [`codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`, { status: 0, stdout: '', stderr: '' }],
    [`codesign --display --verbose=4 ${APP_CONTRACT_BUNDLE}`, { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }],
    [`spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`, { status: 1, stdout: '', stderr: 'rejected' }],
    [[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      acceptanceEndpoint, APP_CONTRACT_BUNDLE,
    ].join(' '), { status: 0, stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`, stderr: '' }],
    ...overrides,
  ]);
  return (command, args = []) => results.get([command, ...args].join(' '))
    ?? { status: 1, stdout: '', stderr: `unexpected command: ${[command, ...args].join(' ')}` };
}

assert.doesNotThrow(() => assertAppBundleContract(contractRun(), APP_CONTRACT_BUNDLE, {
  version: VERSION,
  identifier: 'io.kordi.cloud',
  releaseProfile: 'adhoc-preview',
}));

const productionEndpoint =
  'https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}';
const productionRun = contractRun(new Map([
  [`spctl --assess --type execute --verbose=2 ${APP_CONTRACT_BUNDLE}`,
    { status: 0, stdout: '', stderr: '' }],
  [[
    'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
    productionEndpoint, APP_CONTRACT_BUNDLE,
  ].join(' '), { status: 0, stdout: `${APP_CONTRACT_BUNDLE}/Contents/MacOS/Kordi\n`, stderr: '' }],
]));
assert.doesNotThrow(() => assertAppBundleContract(productionRun, APP_CONTRACT_BUNDLE, {
  version: VERSION,
  identifier: 'io.kordi.cloud',
  releaseProfile: 'production',
}));
```

The passing runner returns:

```text
plutil CFBundleShortVersionString -> 0.0.1-beta.6
plutil CFBundleIdentifier -> io.kordi.cloud
codesign verification -> success
codesign display -> Signature=adhoc and TeamIdentifier=not set
spctl assessment -> rejected diagnostic
rg exact acceptance endpoint -> one matching file
```

Add independent rejection cases using the exact command keys:

```js
const info = `${APP_CONTRACT_BUNDLE}/Contents/Info.plist`;
const rejectionCases = [
  [
    'wrong version',
    new Map([[`plutil -extract CFBundleShortVersionString raw -o - ${info}`,
      { status: 0, stdout: '0.0.1-beta.5.1\n', stderr: '' }]]),
    /version does not match/i,
  ],
  [
    'wrong identifier',
    new Map([[`plutil -extract CFBundleIdentifier raw -o - ${info}`,
      { status: 0, stdout: 'io.kordi.desktop\n', stderr: '' }]]),
    /identifier/i,
  ],
  [
    'normal endpoint',
    new Map([[[
      'rg', '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F',
      acceptanceEndpoint, APP_CONTRACT_BUNDLE,
    ].join(' '), { status: 1, stdout: '', stderr: '' }]]),
    /updater endpoint/i,
  ],
  [
    'Developer ID authority',
    new Map([[`codesign --display --verbose=4 ${APP_CONTRACT_BUNDLE}`,
      { status: 0, stdout: '', stderr: 'Signature=adhoc\nAuthority=Developer ID Application: Example\nTeamIdentifier=not set\n' }]]),
    /identity-free ad-hoc/i,
  ],
  [
    'invalid code signature',
    new Map([[`codesign --verify --deep --strict --verbose=2 ${APP_CONTRACT_BUNDLE}`,
      { status: 1, stdout: '', stderr: 'invalid' }]]),
    /codesign verification failed/i,
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
```

- [ ] **Step 5: Parameterize archive/DMG verification and select the correct verifier**

Import the shared signing policy:

```js
import {
  assertProductionSigningIdentity,
  verifyMacAppSignature,
} from './macos-release-signing.mjs';
```

Replace the production-only `assertSignedApp` callback with a profile-aware bundle contract:

```js
export function assertAppBundleContract(run, appBundle, {
  version,
  identifier = 'io.kordi.cloud',
  releaseProfile,
}) {
  const plist = (key) => requireRun(
    run,
    'plutil',
    ['-extract', key, 'raw', '-o', '-', join(appBundle, 'Contents', 'Info.plist')],
    `Unable to read Kordi.app ${key}`,
  ).stdout.trim();
  if (plist('CFBundleShortVersionString') !== version) {
    throw new Error('Kordi.app version does not match release version');
  }
  if (plist('CFBundleIdentifier') !== identifier) {
    throw new Error('Kordi.app identifier does not match the Cloud product identifier');
  }
  const trust = verifyMacAppSignature({ run, appBundle, profile: releaseProfile });
  const endpoint = releaseProfile === 'adhoc-preview'
    ? 'https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}'
    : 'https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}';
  requireRun(run, 'rg', [
    '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F', endpoint, appBundle,
  ], 'Application bundle does not contain the updater endpoint required by its release profile');
  return trust;
}
```

Make `inspectUpdaterArchive` accept the same bundle-contract callback and invoke it on the extracted app. Invoke it on the top-level app and mounted DMG app as well. Keep privacy scanning for all three copies.

Validate the two preview source overlays before inspecting an ad-hoc artifact:

```js
async function assertAcceptanceConfigParity(repoRoot) {
  const tauriRoot = join(repoRoot, 'app', 'desktop', 'src-tauri');
  const [target, bootstrap] = await Promise.all([
    readFile(join(tauriRoot, 'tauri.cloud.acceptance.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(tauriRoot, 'tauri.cloud.acceptance-bootstrap.conf.json'), 'utf8').then(JSON.parse),
  ]);
  const endpoint = 'https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}';
  for (const config of [target, bootstrap]) {
    if (config.productName !== 'Kordi'
        || config.identifier !== 'io.kordi.cloud'
        || config.bundle?.macOS?.signingIdentity !== '-'
        || JSON.stringify(config.plugins?.updater?.endpoints) !== JSON.stringify([endpoint])) {
      throw new Error('Acceptance Tauri configuration does not match the ad-hoc preview contract');
    }
  }
  if (target.version !== undefined || bootstrap.version !== '0.0.1-beta.5.1') {
    throw new Error('Acceptance Tauri versions do not match the preview contract');
  }
}
```

Create one internal verifier factory. `verifyBundle` is passed to `inspectUpdaterArchive` and used again for the mounted DMG app:

```js
function createArtifactVerifier({ releaseProfile, repoRoot = REPO_ROOT, run = defaultRun, env = process.env }) {
  return {
    async verify(input) {
      const status = requireRun(
        run, 'git', ['status', '--porcelain=v1', '--untracked-files=all'],
        'Unable to inspect release worktree', { cwd: repoRoot },
      );
      if (status.stdout.trim()) throw new Error('Release worktree must be clean');
      const head = requireRun(
        run, 'git', ['rev-parse', 'HEAD'], 'Unable to read release commit', { cwd: repoRoot },
      ).stdout.trim();
      if (head !== input.expectedCommit) {
        throw new Error('Current commit does not match expected release commit');
      }
      await assertVersionParity(repoRoot, input.version);
      if (releaseProfile === 'adhoc-preview') await assertAcceptanceConfigParity(repoRoot);
      if (!(env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim()
          || !(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '').trim()) {
        throw new Error('Tauri updater signing key and password are required');
      }
      if (releaseProfile === 'production') assertProductionSigningIdentity(run);
      verifyTauriUpdaterSignature(input.updaterBytes, input.signature, input.updaterPublicKey);

      const verifyBundle = (appBundle) => {
        assertAppBundleContract(run, appBundle, {
          version: input.version,
          identifier: 'io.kordi.cloud',
          releaseProfile,
        });
        scanReleaseTree(run, appBundle);
      };
      verifyBundle(input.appBundle);
      await inspectUpdaterArchive(run, input.updaterPath, input.version, verifyBundle);

      const mounted = mountDmg(input.manualPath);
      try {
        validateDmgVolumeLayout(mounted.mountPoint, { appName: 'Kordi' });
        verifyBundle(join(mounted.mountPoint, 'Kordi.app'));
        scanReleaseTree(run, mounted.mountPoint);
      } finally {
        detachDmg(mounted.device);
      }
    },
  };
}

export function createProductionVerifier(options = {}) {
  return createArtifactVerifier({ ...options, releaseProfile: 'production' });
}

export function createAdhocPreviewVerifier(options = {}) {
  return createArtifactVerifier({ ...options, releaseProfile: 'adhoc-preview' });
}
```

In `prepareDesktopRelease`, retain injected verifiers for tests and otherwise choose explicitly:

```js
const verifier = dependencies.verifier ?? (
  normalized.releaseProfile === 'adhoc-preview'
    ? createAdhocPreviewVerifier()
    : createProductionVerifier()
);
```

Production still calls `assertVersionParity`, `assertProductionSigningIdentity`, Gatekeeper, updater minisign, privacy scans, and exact endpoint checks already present. Preview also calls `assertVersionParity`, then validates both committed acceptance overlays before inspecting artifacts.

- [ ] **Step 6: Verify publisher behavior and commit**

Run:

```bash
node --test scripts/macos-release-signing.test.mjs scripts/publish-desktop-release.test.mjs
pnpm test:scripts
git diff --check
git add scripts/publish-desktop-release.mjs scripts/lib/desktop-release.mjs scripts/publish-desktop-release.test.mjs
git commit -m "feat(release): gate ad-hoc preview publication"
```

Expected: all script tests PASS, `production` remains the default, and `adhoc-preview --channel beta` performs zero store actions.

### Task 4: Make updater copy and fallback truthful for preview artifacts

**Files:**

- Modify: `app/desktop/src/features/updates/desktopUpdater.ts`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Test: `app/desktop/tests/desktopUpdater.test.ts`
- Test: `app/desktop/tests/desktopUpdaterSourceContract.test.mjs`
- Test: `app/desktop/tests/desktopUpdateButton.test.tsx`

- [ ] **Step 1: Write failing immutable fallback tests**

Replace the fixed fallback constant assertions with:

```ts
import {
  createDesktopUpdaterController,
  manualUpdateUrlForVersion,
} from '../src/features/updates/desktopUpdater';

test('manual fallback is product-origin and version-immutable', () => {
  assert.equal(
    manualUpdateUrlForVersion('0.0.1-beta.6'),
    'https://coordinar.io/updates/releases/0.0.1-beta.6/Kordi_0.0.1-beta.6_aarch64.dmg',
  );
  for (const value of ['', 'latest', '../beta.6', '0.0.1-beta.06', 'https://evil.invalid/x']) {
    assert.equal(manualUpdateUrlForVersion(value), undefined);
  }
});
```

Change controller state expectations to the immutable beta.6 URL. Extend the source-contract test to reject `/updates/releases/latest/Kordi.dmg` and arbitrary hosts.

In `desktopUpdateButton.test.tsx`, require `Installing verified update` and reject `Installing signed update`.

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts
pnpm --dir app/desktop exec node --test tests/desktopUpdaterSourceContract.test.mjs
pnpm --dir app/desktop exec tsx --test tests/desktopUpdateButton.test.tsx
```

Expected: FAIL because the fixed latest URL and signed-update copy remain.

- [ ] **Step 3: Implement strict immutable fallback construction**

Replace the fixed constant with:

```ts
const KORDI_RELEASE_ORIGIN = 'https://coordinar.io';
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

export function manualUpdateUrlForVersion(version: string | undefined) {
  if (!version || !BETA_VERSION.test(version)) return undefined;
  const encoded = encodeURIComponent(version);
  return `${KORDI_RELEASE_ORIGIN}/updates/releases/${encoded}/Kordi_${encoded}_aarch64.dmg`;
}
```

Set `manualDownloadUrl: manualUpdateUrlForVersion(update.version)` in `stateForUpdate`. Change the default controller error to `Unable to install the verified Kordi update.`

- [ ] **Step 4: Correct visible UI wording**

In `desktopUpdateStatusMessage`, use:

```ts
if (state.status === 'installing') return 'Installing verified update…';
if (state.status === 'failed') return state.error || 'Unable to install the verified update.';
```

Keep the existing explanatory sentence `download, verify, install, and relaunch`; it accurately describes both release profiles.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts tests/desktopUpdateButton.test.tsx
pnpm --dir app/desktop exec node --test tests/desktopUpdaterSourceContract.test.mjs
pnpm --dir app/desktop typecheck
git diff --check
git add app/desktop/src/features/updates/desktopUpdater.ts app/desktop/src/pages/WorkspaceSidebar.tsx app/desktop/tests/desktopUpdater.test.ts app/desktop/tests/desktopUpdaterSourceContract.test.mjs app/desktop/tests/desktopUpdateButton.test.tsx
git commit -m "fix(desktop): describe preview updates accurately"
```

Expected: focused tests and typecheck PASS; no renderer-controlled host can reach the manual fallback.

### Task 5: Replace the beta.6 production instructions with the approved preview runbook

**Files:**

- Modify: `docs/release.md`

- [ ] **Step 1: Write the runbook section before changing old claims**

Add `### Beta.6 ad-hoc external-test preview` under Hosted Desktop beta releases with these non-negotiable statements:

```markdown
Beta.6 is an acceptance-only, ad-hoc-signed external-test preview. It is not Apple-signed, notarized, tagged, mirrored to a public GitHub release, or promoted to `desktop/channels/beta/latest.json`. Invited testers install beta.5.1 manually once and use Apple's per-app **Open Anyway** flow. Do not disable Gatekeeper or remove quarantine attributes.

Use `--release-profile adhoc-preview --channel acceptance`. The publisher rejects every other ad-hoc channel combination. Beta.6 immutable objects are never replaced or promoted to beta. The next Developer ID-signed and notarized release is beta.7; publish beta.7 to acceptance first so preview clients update into a bundle whose embedded endpoint returns them to normal beta.
```

Document the two exact build commands:

```bash
CARGO_TARGET_DIR="$HOME/.cache/kordi/releases/beta6-adhoc" \
  pnpm --dir app/desktop tauri:build:cloud:adhoc-preview
CARGO_TARGET_DIR="$HOME/.cache/kordi/releases/beta51-bootstrap" \
  pnpm --dir app/desktop tauri:build:cloud:adhoc-bootstrap
```

Add this exact preview publication shape, while retaining the existing protected-file credential and loopback-tunnel setup immediately above it:

```bash
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date "$PUB_DATE"
```

Add the exact lifecycle rule: keep acceptance live while external testers are enrolled; to rehearse rollback, run `pnpm release:clear-desktop-acceptance`, verify acceptance returns 204, then rerun the exact publisher command above and verify beta.5.1 receives beta.6 again before sending invitations.

- [ ] **Step 2: Remove contradictory beta.6 production directions**

Rewrite sentences that call beta.6 notarized, direct operators to promote beta.6 to beta, or create `V0.0.1.beta6`. Keep the generic signed-release procedure for beta.7 and later. Preserve secret names and the production verifier instructions.

- [ ] **Step 3: Self-check the runbook and commit**

Run, rejecting the old production-only beta.6 sentences explicitly:

```bash
! rg -n 'The beta\.6 updater uses a Tauri minisign key and a notarized Developer ID build' docs/release.md
! rg -n 'Only after promotion passes, create annotated tag `V0\.0\.1\.beta6`' docs/release.md
rg -n "adhoc-preview|Open Anyway|beta\.7|acceptance" docs/release.md
git diff --check
git add docs/release.md
git commit -m "docs(release): document beta6 ad-hoc preview"
```

Expected: both negated searches succeed because the obsolete sentences are absent; the positive search returns the complete preview and exit flow.

### Task 6: Run complete local validation and review

**Files:** Review every file changed since `origin/main`; change only to repair a demonstrated failure.

- [ ] **Step 1: Install exact dependencies in the isolated worktree**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: exit 0 with no lockfile change.

- [ ] **Step 2: Run focused release and updater suites**

Run:

```bash
pnpm --dir app/desktop exec node --test tests/tauriUpdaterConfig.test.mjs tests/releasePrerequisites.test.mjs tests/desktopUpdaterSourceContract.test.mjs tests/releaseVersion.test.mjs
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts tests/desktopUpdateButton.test.tsx
node --test scripts/macos-release-signing.test.mjs scripts/publish-desktop-release.test.mjs scripts/clear-desktop-release-channel.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 3: Run full project gates**

Run:

```bash
pnpm check:frontend
pnpm check:rust:fmt
pnpm check:rust:clippy
pnpm check:rust:test
pnpm test:scripts
pnpm check:hygiene
pnpm --dir app/desktop bench:chat-scale
```

Expected: every command exits 0 and the benchmark reports no threshold regression.

- [ ] **Step 4: Review the complete diff and secret surface**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
pnpm --dir app/desktop release:secret-guard
```

Read the entire diff. Confirm production defaults still use the normal beta endpoint and Developer ID/Gatekeeper checks. Confirm no key, password, private MinIO URL, user data, or generated artifact is tracked.

- [ ] **Step 5: Repair only evidenced failures and leave a clean branch**

For each failure, add or tighten its regression test first, rerun the focused command, then rerun Step 3. Commit verified repairs with a scope-specific `fix:` message. Finish with:

```bash
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: exit 0.

### Task 7: Open, review, and merge one implementation PR

**Files:** No source files unless CI or review exposes a demonstrated defect.

- [ ] **Step 1: Push the branch and open the PR**

Run:

```bash
git push -u origin feat/beta6-adhoc-preview
gh pr create \
  --repo Kordi-AI/Kordi \
  --base main \
  --head feat/beta6-adhoc-preview \
  --draft \
  --title "feat(release): add ad-hoc beta6 acceptance preview" \
  --body $'Implements the approved ad-hoc beta.6 acceptance-preview design.\n\nSafety boundaries:\n- acceptance only; beta publishing is rejected\n- production Developer ID/Gatekeeper gates remain default\n- updater archives remain Tauri-signed\n- no beta.6 tag or public GitHub release\n- future production release is beta.7\n\nDesign: docs/superpowers/specs/2026-07-13-beta6-adhoc-acceptance-preview-design.md\nPlan: docs/superpowers/plans/2026-07-13-beta6-adhoc-acceptance-preview.md'
```

Expected: one draft PR URL.

- [ ] **Step 2: Review CI, comments, and the complete GitHub diff**

Run:

```bash
PR_NUMBER="$(gh pr view --repo Kordi-AI/Kordi --json number --jq .number)"
gh pr checks "$PR_NUMBER" --repo Kordi-AI/Kordi --watch --interval 10
gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --comments
gh pr diff "$PR_NUMBER" --repo Kordi-AI/Kordi
```

Expected: all required checks PASS and no unresolved actionable review remains. Fix any failure test-first and repeat Task 6 before pushing.

- [ ] **Step 3: Mark ready and merge**

Run:

```bash
gh pr ready "$PR_NUMBER" --repo Kordi-AI/Kordi
gh pr merge "$PR_NUMBER" --repo Kordi-AI/Kordi --merge
git fetch origin main
MERGE_COMMIT="$(gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --json mergeCommit --jq .mergeCommit.oid)"
test "$(git rev-parse origin/main)" = "$MERGE_COMMIT"
```

Expected: PR merged and `origin/main` equals the recorded merge commit. Do not create a tag or GitHub release.

### Task 8: Build and locally verify both ad-hoc artifacts from merged main

**Files:** Build outputs live outside Git; no source mutation.

- [ ] **Step 1: Create a clean detached release worktree and protected artifact root**

Run:

```bash
MERGE_COMMIT="$(gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --json mergeCommit --jq .mergeCommit.oid)"
RELEASE_WORKTREE="$HOME/.config/superpowers/worktrees/kordi/beta6-adhoc-release-${MERGE_COMMIT:0:8}"
ARTIFACT_ROOT="$HOME/.cache/kordi/releases/0.0.1-beta.6-adhoc-${MERGE_COMMIT:0:8}"
git worktree add --detach "$RELEASE_WORKTREE" "$MERGE_COMMIT"
install -d -m 700 "$ARTIFACT_ROOT/release-beta6"
cd "$RELEASE_WORKTREE"
pnpm install --frozen-lockfile
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: clean detached worktree at the merge commit.

- [ ] **Step 2: Load only the Tauri updater-signing secrets**

Run with shell tracing disabled:

```bash
set +x
SECRET_DIR="$(mktemp -d /tmp/kordi-tauri-preview.XXXXXX)"
chmod 700 "$SECRET_DIR"
trap 'unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; rm -rf "$SECRET_DIR"' EXIT
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key --project hai-gcp-representation --out-file "$SECRET_DIR/private-key" --quiet
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key-password --project hai-gcp-representation --out-file "$SECRET_DIR/password" --quiet
export TAURI_SIGNING_PRIVATE_KEY="$(<"$SECRET_DIR/private-key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(<"$SECRET_DIR/password")"
unset VITE_KORDI_CLOUD_API_BASE
```

Expected: both variables are non-empty; no Apple secret or identity is loaded.

- [ ] **Step 3: Build beta.6 and beta.5.1 into separate targets**

Run:

```bash
CARGO_TARGET_DIR="$ARTIFACT_ROOT/target-beta6" pnpm --dir app/desktop tauri:build:cloud:adhoc-preview
CARGO_TARGET_DIR="$ARTIFACT_ROOT/target-bootstrap" pnpm --dir app/desktop tauri:build:cloud:adhoc-bootstrap
```

Expected beta.6 outputs:

```text
$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app
$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app.tar.gz
$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app.tar.gz.sig
$ARTIFACT_ROOT/target-beta6/release/bundle/dmg/Kordi_0.0.1-beta.6_aarch64.dmg
```

Expected bootstrap output:

```text
$ARTIFACT_ROOT/target-bootstrap/release/bundle/dmg/Kordi_0.0.1-beta.5.1_aarch64.dmg
```

- [ ] **Step 4: Stage beta.6 publisher inputs and run both prerequisite and publisher dry-run gates**

Run:

```bash
cp "$ARTIFACT_ROOT/target-beta6/release/bundle/dmg/Kordi_0.0.1-beta.6_aarch64.dmg" "$ARTIFACT_ROOT/release-beta6/"
cp "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app.tar.gz" "$ARTIFACT_ROOT/release-beta6/"
cp "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app.tar.gz.sig" "$ARTIFACT_ROOT/release-beta6/"
pnpm --dir app/desktop release:prerequisites -- \
  --release-profile adhoc-preview \
  --expected-commit "$MERGE_COMMIT" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$MERGE_COMMIT" \
  --pub-date "$PUB_DATE" \
  --dry-run
```

Expected: ad-hoc code signatures and updater minisign pass, Gatekeeper is recorded only as a diagnostic, and metadata is generated without network access.

- [ ] **Step 5: Record non-secret artifact evidence and remove signing material**

Run:

```bash
shasum -a 256 \
  "$ARTIFACT_ROOT/release-beta6/Kordi_0.0.1-beta.6_aarch64.dmg" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig" \
  "$ARTIFACT_ROOT/target-bootstrap/release/bundle/dmg/Kordi_0.0.1-beta.5.1_aarch64.dmg"
stat -f '%z %N' \
  "$ARTIFACT_ROOT/release-beta6/Kordi_0.0.1-beta.6_aarch64.dmg" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig" \
  "$ARTIFACT_ROOT/target-bootstrap/release/bundle/dmg/Kordi_0.0.1-beta.5.1_aarch64.dmg"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rm -rf "$SECRET_DIR"
trap - EXIT
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: four hashes/sizes recorded, protected secret directory removed, release worktree clean.

### Task 9: Publish beta.6 to acceptance and prove beta isolation

**Files:** MinIO acceptance pointer and immutable objects only; no Git or beta-channel mutation.

- [ ] **Step 1: Capture the pre-publication public state**

Run:

```bash
PR_NUMBER="$(gh pr view --repo Kordi-AI/Kordi --json number --jq .number)"
MERGE_COMMIT="$(gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --json mergeCommit --jq .mergeCommit.oid)"
RELEASE_WORKTREE="$HOME/.config/superpowers/worktrees/kordi/beta6-adhoc-release-${MERGE_COMMIT:0:8}"
ARTIFACT_ROOT="$HOME/.cache/kordi/releases/0.0.1-beta.6-adhoc-${MERGE_COMMIT:0:8}"
cd "$RELEASE_WORKTREE"
PUB_DATE="$(jq -r .pubDate "$ARTIFACT_ROOT/release-beta6/release.json")"
NORMAL_BEFORE_STATUS="$(curl -sS -o /tmp/kordi-normal-before.json -w '%{http_code}' \
  https://coordinar.io/updates/desktop/darwin/aarch64/0.0.1-beta.5.1)"
STABLE_BEFORE_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  https://coordinar.io/updates/releases/latest/Kordi.dmg)"
ACCEPTANCE_BEFORE_STATUS="$(curl -sS -o /tmp/kordi-acceptance-before.json -w '%{http_code}' \
  https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1)"
test "$ACCEPTANCE_BEFORE_STATUS" = 204
```

Expected before preview: normal beta and stable DMG preserve their prior status; acceptance is 204/unpublished.

- [ ] **Step 2: Start the two-hop loopback-only MinIO tunnel**

In a persistent VM terminal run:

```bash
gcloud compute ssh --zone "us-central1-a" "kordi-product" --project "hai-gcp-representation" --command \
  "kubectl -n kordi-cloud port-forward service/minio 9900:9000 --address 127.0.0.1"
```

In a second persistent local terminal run:

```bash
gcloud compute ssh --zone "us-central1-a" "kordi-product" \
  --project "hai-gcp-representation" -- -N -L 9900:127.0.0.1:9900
```

Expected: `127.0.0.1:9900` accepts the S3 connection locally; MinIO is not exposed publicly.

- [ ] **Step 3: Load publisher credentials without printing them**

Run in the release worktree:

```bash
set +x
PUBLISHER_SECRET_DIR="$(mktemp -d /tmp/kordi-release-publisher.XXXXXX)"
chmod 700 "$PUBLISHER_SECRET_DIR"
trap 'unset KORDI_RELEASE_PUBLISHER_ACCESS_KEY KORDI_RELEASE_PUBLISHER_SECRET_KEY; rm -rf "$PUBLISHER_SECRET_DIR"' EXIT
gcloud secrets versions access latest --secret kordi-release-publisher-access-key --project hai-gcp-representation --out-file "$PUBLISHER_SECRET_DIR/access" --quiet
gcloud secrets versions access latest --secret kordi-release-publisher-secret-key --project hai-gcp-representation --out-file "$PUBLISHER_SECRET_DIR/secret" --quiet
export KORDI_RELEASE_PUBLISHER_ACCESS_KEY="$(<"$PUBLISHER_SECRET_DIR/access")"
export KORDI_RELEASE_PUBLISHER_SECRET_KEY="$(<"$PUBLISHER_SECRET_DIR/secret")"
export KORDI_RELEASE_S3_ENDPOINT=http://127.0.0.1:9900
export KORDI_RELEASE_S3_BUCKET=kordi-releases
export KORDI_RELEASE_S3_REGION=us-east-1
```

- [ ] **Step 4: Reload the Tauri updater key and publish only the acceptance pointer**

The publisher re-verifies the updater signature, so load the key into a second protected directory and publish:

```bash
TAURI_SECRET_DIR="$(mktemp -d /tmp/kordi-tauri-publisher.XXXXXX)"
chmod 700 "$TAURI_SECRET_DIR"
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key --project hai-gcp-representation --out-file "$TAURI_SECRET_DIR/private-key" --quiet
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key-password --project hai-gcp-representation --out-file "$TAURI_SECRET_DIR/password" --quiet
export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SECRET_DIR/private-key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(<"$TAURI_SECRET_DIR/password")"
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$MERGE_COMMIT" \
  --pub-date "$PUB_DATE"
```

Expected: immutable objects upload idempotently, public GET/HEAD checks pass, and `desktop/channels/acceptance/latest.json` is the final write.

- [ ] **Step 5: Verify acceptance and prove production beta did not change**

Run:

```bash
curl -fsS https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1 | jq -e '
  .version == "0.0.1-beta.6"
  and (.notes | contains("ad-hoc external-test preview"))
  and (.url | startswith("https://coordinar.io/updates/releases/0.0.1-beta.6/"))
  and (.signature | type == "string" and length > 100)
'
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.6)" = 204
NORMAL_AFTER_STATUS="$(curl -sS -o /tmp/kordi-normal-after.json -w '%{http_code}' \
  https://coordinar.io/updates/desktop/darwin/aarch64/0.0.1-beta.5.1)"
STABLE_AFTER_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  https://coordinar.io/updates/releases/latest/Kordi.dmg)"
test "$NORMAL_AFTER_STATUS" = "$NORMAL_BEFORE_STATUS"
test "$STABLE_AFTER_STATUS" = "$STABLE_BEFORE_STATUS"
cmp /tmp/kordi-normal-before.json /tmp/kordi-normal-after.json
```

Expected: beta.5.1 receives beta.6 only from acceptance; equal beta.6 receives 204; normal beta and stable manual download retain their pre-publication state.

- [ ] **Step 6: Remove credentials from the process**

Run:

```bash
unset KORDI_RELEASE_PUBLISHER_ACCESS_KEY KORDI_RELEASE_PUBLISHER_SECRET_KEY TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rm -rf "$PUBLISHER_SECRET_DIR" "$TAURI_SECRET_DIR"
trap - EXIT
```

Expected: no release credential remains exported.

### Task 10: Perform clean-machine beta.5.1 to beta.6 acceptance

**Files:** A disposable macOS arm64 user profile and acceptance pointer only.

- [ ] **Step 1: Seed a disposable tester profile before installation**

Re-establish the release variables in the operator terminal:

```bash
PR_NUMBER="$(gh pr view --repo Kordi-AI/Kordi --json number --jq .number)"
MERGE_COMMIT="$(gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --json mergeCommit --jq .mergeCommit.oid)"
RELEASE_WORKTREE="$HOME/.config/superpowers/worktrees/kordi/beta6-adhoc-release-${MERGE_COMMIT:0:8}"
ARTIFACT_ROOT="$HOME/.cache/kordi/releases/0.0.1-beta.6-adhoc-${MERGE_COMMIT:0:8}"
cd "$RELEASE_WORKTREE"
PUB_DATE="$(jq -r .pubDate "$ARTIFACT_ROOT/release-beta6/release.json")"
```

Use a normal macOS arm64 user with Gatekeeper enabled. In beta.5 or the bootstrap, create and record:

```text
one authenticated Cloud account
one Keychain-backed session
one direct conversation
one group with two sessions
one unsent draft
one theme preference
one cached long transcript
```

Take screenshots of the visible markers and record the current version from the app bundle.

- [ ] **Step 2: Exercise real quarantine and Apple's per-app approval**

Transfer `Kordi_0.0.1-beta.5.1_aarch64.dmg` through a browser or external download so quarantine is present. Verify quarantine without removing it:

```bash
xattr -l "$HOME/Downloads/Kordi_0.0.1-beta.5.1_aarch64.dmg" | rg com\.apple\.quarantine
```

Drag Kordi to Applications. Attempt launch once, then use **System Settings > Privacy & Security > Open Anyway**. Do not run `xattr -d`, `spctl --master-disable`, or any global policy change.

- [ ] **Step 3: Confirm one in-app update and require automatic relaunch**

Inside Kordi, confirm beta.6 once. Record these transitions:

```text
available -> downloading -> installing verified update -> relaunching
```

After relaunch, verify:

```bash
test "$(plutil -extract CFBundleShortVersionString raw -o - /Applications/Kordi.app/Contents/Info.plist)" = 0.0.1-beta.6
codesign --verify --deep --strict --verbose=2 /Applications/Kordi.app
codesign --display --verbose=4 /Applications/Kordi.app 2>&1 | rg '^Signature=adhoc$|^TeamIdentifier=not set$'
```

Expected: Kordi relaunches automatically without a second security override. If macOS blocks relaunch or asks for a second approval, stop external rollout and return to design review.

- [ ] **Step 4: Verify state preservation and steady-state updater behavior**

Confirm every marker from Step 1 remains. Quit and reopen Kordi normally. Verify:

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.6)" = 204
```

Expected: version remains beta.6, all account/session/cache/draft/theme markers remain, and no repeated update appears.

- [ ] **Step 5: Prove local tampering is rejected without touching MinIO**

Run the exported signature verifier once against the original archive and once against a changed temporary copy:

```bash
TAMPERED_ARCHIVE="$(mktemp /tmp/Kordi.app.tampered.XXXXXX.tar.gz)"
cp "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz" "$TAMPERED_ARCHIVE"
printf '\000' | dd of="$TAMPERED_ARCHIVE" bs=1 seek=0 count=1 conv=notrunc 2>/dev/null
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  import { verifyTauriUpdaterSignature } from "./scripts/lib/desktop-release.mjs";
  const [archivePath, signaturePath] = process.argv.slice(1);
  const archive = await readFile(archivePath);
  const signature = (await readFile(signaturePath, "utf8")).trim();
  verifyTauriUpdaterSignature(archive, signature);
' "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz" "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig"
if node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  import { verifyTauriUpdaterSignature } from "./scripts/lib/desktop-release.mjs";
  const [archivePath, signaturePath] = process.argv.slice(1);
  const archive = await readFile(archivePath);
  const signature = (await readFile(signaturePath, "utf8")).trim();
  verifyTauriUpdaterSignature(archive, signature);
' "$TAMPERED_ARCHIVE" "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig"; then
  exit 1
fi
rm -f "$TAMPERED_ARCHIVE"
open -a Kordi
```

Expected: original verification exits 0, changed bytes produce `Updater signature verification failed`, and the installed app still opens. Never upload the changed file.

- [ ] **Step 6: Rehearse acceptance cleanup and restore the exact beta.6 pointer**

Load both credential pairs into protected temporary directories, then rehearse cleanup and restoration:

```bash
set +x
PUBLISHER_SECRET_DIR="$(mktemp -d /tmp/kordi-release-publisher-rehearsal.XXXXXX)"
TAURI_SECRET_DIR="$(mktemp -d /tmp/kordi-tauri-rehearsal.XXXXXX)"
chmod 700 "$PUBLISHER_SECRET_DIR" "$TAURI_SECRET_DIR"
trap 'unset KORDI_RELEASE_PUBLISHER_ACCESS_KEY KORDI_RELEASE_PUBLISHER_SECRET_KEY TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; rm -rf "$PUBLISHER_SECRET_DIR" "$TAURI_SECRET_DIR"' EXIT
gcloud secrets versions access latest --secret kordi-release-publisher-access-key --project hai-gcp-representation --out-file "$PUBLISHER_SECRET_DIR/access" --quiet
gcloud secrets versions access latest --secret kordi-release-publisher-secret-key --project hai-gcp-representation --out-file "$PUBLISHER_SECRET_DIR/secret" --quiet
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key --project hai-gcp-representation --out-file "$TAURI_SECRET_DIR/private-key" --quiet
gcloud secrets versions access latest --secret kordi-tauri-updater-private-key-password --project hai-gcp-representation --out-file "$TAURI_SECRET_DIR/password" --quiet
export KORDI_RELEASE_PUBLISHER_ACCESS_KEY="$(<"$PUBLISHER_SECRET_DIR/access")"
export KORDI_RELEASE_PUBLISHER_SECRET_KEY="$(<"$PUBLISHER_SECRET_DIR/secret")"
export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SECRET_DIR/private-key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(<"$TAURI_SECRET_DIR/password")"
export KORDI_RELEASE_S3_ENDPOINT=http://127.0.0.1:9900
export KORDI_RELEASE_S3_BUCKET=kordi-releases
export KORDI_RELEASE_S3_REGION=us-east-1
pnpm release:clear-desktop-acceptance
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1)" = 204
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$MERGE_COMMIT" \
  --pub-date "$PUB_DATE"
curl -fsS https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1 | jq -e '.version == "0.0.1-beta.6"'
unset KORDI_RELEASE_PUBLISHER_ACCESS_KEY KORDI_RELEASE_PUBLISHER_SECRET_KEY TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rm -rf "$PUBLISHER_SECRET_DIR" "$TAURI_SECRET_DIR"
trap - EXIT
```

Expected: tombstone produces 204, republishing is immutable/idempotent, and the exact beta.6 acceptance manifest returns before any invitation is sent.

- [ ] **Step 7: Prepare the invited-tester handoff without creating a public release**

Provide named testers with:

```text
Kordi_0.0.1-beta.5.1_aarch64.dmg
its SHA-256
the source merge commit
the statement "ad-hoc test preview; not Apple notarized"
Apple's Open Anyway steps
the expected automatic beta.6 update and relaunch flow
a stop/report instruction if a second security override appears
```

Confirm all of the following remain absent:

```bash
test -z "$(git tag -l V0.0.1.beta6)"
test "$(gh release view V0.0.1.beta6 --repo Kordi-AI/Kordi >/dev/null 2>&1; echo $?)" != 0
test "$(curl -sS -o /dev/null -w '%{http_code}' https://coordinar.io/updates/releases/latest/Kordi.dmg)" != 200
```

Expected: invited testers have the bootstrap and evidence, acceptance remains live, and no public beta pointer, stable beta.6 DMG, tag, or GitHub release exists.

### Task 11: Final audit and handoff

**Files:** No source changes unless a verified issue is found.

- [ ] **Step 1: Audit repository and production state**

Run:

```bash
gh pr view "$PR_NUMBER" --repo Kordi-AI/Kordi --json state,mergeCommit,url
git fetch origin main --tags
test "$(git rev-parse origin/main)" = "$MERGE_COMMIT"
test -z "$(git tag -l V0.0.1.beta6)"
curl -fsS https://coordinar.io/health
curl -fsS https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1 | jq -e '.version == "0.0.1-beta.6"'
test "$(curl -sS -o /dev/null -w '%{http_code}' https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.6)" = 204
git -C "$RELEASE_WORKTREE" status --short
```

Expected: merged implementation, clean release worktree, healthy production service, beta.6 acceptance manifest, and no beta.6 production tag.

- [ ] **Step 2: Report evidence without secrets**

Report:

```text
implementation PR URL and merge commit
beta.5.1 bootstrap SHA-256 and size
beta.6 DMG/archive/signature SHA-256 and sizes
acceptance manifest status matrix
normal beta/stable-DMG unchanged proof
clean-machine Open Anyway/install/relaunch result
state-preservation result
cleanup/restore rehearsal result
explicit absence of V0.0.1.beta6 and public GitHub release
future exit version: signed/notarized beta.7
```

Do not include updater private-key material, passwords, MinIO credentials, internal service URLs, user data, or signed internal URLs.

- [ ] **Step 3: Keep acceptance live only for the approved preview window**

Do not clear acceptance while invited testers remain on beta.6. When beta.7 is ready, publish the signed beta.7 artifact to acceptance first, verify beta.6 to beta.7 migration, confirm the beta.7 bundle follows the normal beta endpoint, then clear acceptance and promote beta.7 through the production process.
