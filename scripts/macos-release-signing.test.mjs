import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELEASE_PROFILES,
  assertProductionSigningIdentity,
  verifyMacAppSignature,
} from './lib/macos-release-signing.mjs';

function ok(stdout = '', stderr = '') {
  return { status: 0, stdout, stderr };
}

function fail(stderr = 'command failed') {
  return { status: 1, stdout: '', stderr };
}

function fakeRun(results) {
  return (command, args = []) => results.get([command, ...args].join(' '))
    ?? fail(`unexpected command: ${[command, ...args].join(' ')}`);
}

const APP = '/tmp/Kordi.app';
const VERIFY_COMMAND = `codesign --verify --deep --strict --verbose=2 ${APP}`;
const DISPLAY_COMMAND = `codesign --display --verbose=4 ${APP}`;
const ASSESS_COMMAND = `spctl --assess --type execute --verbose=2 ${APP}`;

test('exports immutable production and ad-hoc preview release profiles', () => {
  assert.deepEqual(RELEASE_PROFILES, {
    PRODUCTION: 'production',
    ADHOC_PREVIEW: 'adhoc-preview',
  });
  assert.equal(Object.isFrozen(RELEASE_PROFILES), true);
});

test('accepts an available Developer ID Application signing identity', () => {
  const run = fakeRun(new Map([
    [
      'security find-identity -v -p codesigning',
      ok('', '  1) ABCDEF "Developer ID Application: Example (TEAMID)"\n     1 valid identities found'),
    ],
  ]));

  assert.deepEqual(assertProductionSigningIdentity(run), {
    signingIdentityAvailable: true,
  });
});

test('rejects identity output without a Developer ID Application identity', () => {
  const run = fakeRun(new Map([
    ['security find-identity -v -p codesigning', ok('1 valid identities found')],
  ]));

  assert.throws(
    () => assertProductionSigningIdentity(run),
    /valid Developer ID Application signing identity is required/i,
  );
});

test('rejects identity output reporting zero valid identities', () => {
  const run = fakeRun(new Map([
    [
      'security find-identity -v -p codesigning',
      ok('Developer ID Application: Example (TEAMID)\n0 valid identities found'),
    ],
  ]));

  assert.throws(
    () => assertProductionSigningIdentity(run),
    /valid Developer ID Application signing identity is required/i,
  );
});

test('reports identity-discovery command failure without exposing command output', () => {
  const run = fakeRun(new Map([
    ['security find-identity -v -p codesigning', fail('private identity detail')],
  ]));

  assert.throws(
    () => assertProductionSigningIdentity(run),
    (error) => {
      assert.match(error.message, /unable to inspect macOS signing identities/i);
      assert.doesNotMatch(error.message, /private identity detail/i);
      return true;
    },
  );
});

test('production verification requires valid codesign and passing Gatekeeper', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [ASSESS_COMMAND, ok()],
  ]));

  assert.deepEqual(verifyMacAppSignature({
    run,
    appBundle: APP,
    profile: RELEASE_PROFILES.PRODUCTION,
  }), {
    codesignVerified: true,
    gatekeeperVerified: true,
    signingKind: 'developer-id',
  });
});

test('production verification rejects a failed codesign check', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, fail('bad signature detail')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.PRODUCTION,
    }),
    (error) => {
      assert.match(error.message, /codesign verification failed/i);
      assert.doesNotMatch(error.message, /bad signature detail/i);
      return true;
    },
  );
});

test('production verification rejects a failed Gatekeeper assessment', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [ASSESS_COMMAND, fail('private rejection detail')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.PRODUCTION,
    }),
    (error) => {
      assert.match(error.message, /Gatekeeper assessment failed/i);
      assert.doesNotMatch(error.message, /private rejection detail/i);
      return true;
    },
  );
});

test('ad-hoc verification accepts an identity-free signature and treats Gatekeeper as diagnostic', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, ok('', 'Executable=/tmp/Kordi.app/Contents/MacOS/Kordi\nSignature=adhoc\nTeamIdentifier=not set\n')],
    [ASSESS_COMMAND, fail('rejected')],
  ]));

  assert.deepEqual(verifyMacAppSignature({
    run,
    appBundle: APP,
    profile: RELEASE_PROFILES.ADHOC_PREVIEW,
  }), {
    codesignVerified: true,
    gatekeeperVerified: false,
    signingKind: 'adhoc',
  });
});

test('ad-hoc verification accepts an absent TeamIdentifier and reports passing Gatekeeper', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, ok('Signature=adhoc\n')],
    [ASSESS_COMMAND, ok()],
  ]));

  assert.deepEqual(verifyMacAppSignature({
    run,
    appBundle: APP,
    profile: RELEASE_PROFILES.ADHOC_PREVIEW,
  }), {
    codesignVerified: true,
    gatekeeperVerified: true,
    signingKind: 'adhoc',
  });
});

test('ad-hoc verification rejects an Authority identity', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, ok('', 'Signature=adhoc\nAuthority=Developer ID Application: Example (TEAMID)\nTeamIdentifier=not set\n')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.ADHOC_PREVIEW,
    }),
    /identity-free ad-hoc code signature is required/i,
  );
});

test('ad-hoc verification rejects a configured TeamIdentifier', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, ok('', 'Signature=adhoc\nTeamIdentifier=TEAM123\n')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.ADHOC_PREVIEW,
    }),
    /identity-free ad-hoc code signature is required/i,
  );
});

test('ad-hoc verification rejects a signature without the ad-hoc marker', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, ok('', 'TeamIdentifier=not set\n')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.ADHOC_PREVIEW,
    }),
    /identity-free ad-hoc code signature is required/i,
  );
});

test('ad-hoc verification rejects a failed codesign check', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, fail('bad signature')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.ADHOC_PREVIEW,
    }),
    /codesign verification failed/i,
  );
});

test('ad-hoc verification rejects a failed signature display command', () => {
  const run = fakeRun(new Map([
    [VERIFY_COMMAND, ok()],
    [DISPLAY_COMMAND, fail('private display detail')],
  ]));

  assert.throws(
    () => verifyMacAppSignature({
      run,
      appBundle: APP,
      profile: RELEASE_PROFILES.ADHOC_PREVIEW,
    }),
    (error) => {
      assert.match(error.message, /unable to inspect the application bundle signature/i);
      assert.doesNotMatch(error.message, /private display detail/i);
      return true;
    },
  );
});

test('rejects an unknown release profile', () => {
  assert.throws(
    () => verifyMacAppSignature({
      run: fakeRun(new Map()),
      appBundle: APP,
      profile: 'unsigned',
    }),
    /production or adhoc-preview/i,
  );
});
