import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkReleasePrerequisites,
  parseReleasePrerequisiteArguments,
  redactReleaseText,
} from '../scripts/check-release-prerequisites.mjs';

const COMMIT = 'beabfe8f49d868d9ac7848f31a044321b9e22c67';
const APP = '/tmp/Kordi.app';

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function failure(stderr = 'command failed') {
  return { status: 1, stdout: '', stderr };
}

function fakeDependencies(overrides = {}) {
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: 'private-key-secret',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-secret',
    ...overrides.env,
  };
  const results = new Map([
    ['git status --porcelain=v1 --untracked-files=all', success('')],
    ['git rev-parse HEAD', success(`${COMMIT}\n`)],
    ['security find-identity -v -p codesigning', success('  1) ABCDEF "Developer ID Application: Example (TEAMID)"\n     1 valid identities found')],
    [`codesign --verify --deep --strict --verbose=2 ${APP}`, success('')],
    [`spctl --assess --type execute --verbose=2 ${APP}`, success('')],
    ...(overrides.results ?? []),
  ]);
  return {
    env,
    run(command, args = []) {
      const key = [command, ...args].join(' ');
      return results.get(key) ?? failure(`unexpected command: ${key}`);
    },
  };
}

test('accepts an exact clean release commit with signing and Apple trust checks', () => {
  const result = checkReleasePrerequisites(
    { expectedCommit: COMMIT, appBundle: APP },
    fakeDependencies(),
  );

  assert.deepEqual(result, {
    commit: COMMIT,
    sourceOnly: false,
    signingIdentityAvailable: true,
    codesignVerified: true,
    gatekeeperVerified: true,
  });
});

test('source-only mode verifies source without claiming artifact trust', () => {
  const result = checkReleasePrerequisites(
    { expectedCommit: COMMIT, sourceOnly: true },
    fakeDependencies({ env: {} }),
  );

  assert.deepEqual(result, {
    commit: COMMIT,
    sourceOnly: true,
    signingIdentityAvailable: false,
    codesignVerified: false,
    gatekeeperVerified: false,
  });
});

test('rejects a dirty worktree and a commit mismatch', () => {
  assert.throws(
    () => checkReleasePrerequisites(
      { expectedCommit: COMMIT, sourceOnly: true },
      fakeDependencies({
        results: [['git status --porcelain=v1 --untracked-files=all', success('?? private.key\n')]],
      }),
    ),
    /worktree must be clean/i,
  );

  assert.throws(
    () => checkReleasePrerequisites(
      { expectedCommit: COMMIT, sourceOnly: true },
      fakeDependencies({
        results: [['git rev-parse HEAD', success('1111111111111111111111111111111111111111\n')]],
      }),
    ),
    /does not match expected release commit/i,
  );
});

test('rejects missing updater signing environment', () => {
  for (const missing of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
    const deps = fakeDependencies();
    delete deps.env[missing];
    assert.throws(
      () => checkReleasePrerequisites({ expectedCommit: COMMIT, appBundle: APP }, deps),
      new RegExp(`${missing} is required`),
    );
  }
});

test('rejects a missing Apple identity, invalid code signature, and failed Gatekeeper assessment', () => {
  assert.throws(
    () => checkReleasePrerequisites(
      { expectedCommit: COMMIT, appBundle: APP },
      fakeDependencies({
        results: [['security find-identity -v -p codesigning', success('0 valid identities found')]],
      }),
    ),
    /Developer ID Application signing identity is required/i,
  );

  assert.throws(
    () => checkReleasePrerequisites(
      { expectedCommit: COMMIT, appBundle: APP },
      fakeDependencies({
        results: [[`codesign --verify --deep --strict --verbose=2 ${APP}`, failure('bad signature')]],
      }),
    ),
    /codesign verification failed/i,
  );

  assert.throws(
    () => checkReleasePrerequisites(
      { expectedCommit: COMMIT, appBundle: APP },
      fakeDependencies({
        results: [[`spctl --assess --type execute --verbose=2 ${APP}`, failure('rejected')]],
      }),
    ),
    /Gatekeeper assessment failed/i,
  );
});

test('redaction removes signing values, credentials, internal URLs, and identity details', () => {
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: 'private-key-secret',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-secret',
    KORDI_RELEASE_PUBLISHER_SECRET_KEY: 'publisher-secret',
  };
  const input = 'private-key-secret password-secret publisher-secret https://minio.internal:9000/object Developer ID Application: Person Name (TEAM123)';
  const redacted = redactReleaseText(input, env);

  assert.doesNotMatch(redacted, /private-key-secret|password-secret|publisher-secret|Person Name|TEAM123|minio\.internal/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('pnpm argument separator is ignored by the release prerequisite CLI parser', () => {
  assert.deepEqual(
    parseReleasePrerequisiteArguments(['--', '--source-only', '--expected-commit', COMMIT]),
    { sourceOnly: true, expectedCommit: COMMIT },
  );
});
