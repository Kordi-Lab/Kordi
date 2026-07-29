import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_PLATFORM_KEYS,
  detectMusl,
  resolvePlatformBinaryName,
} from '../bridges/scripts/platform-binary.js';

const targetCases = [
  ['darwin', 'arm64', false, 'bridges-darwin-arm64'],
  ['darwin', 'x64', false, 'bridges-darwin-x64'],
  ['linux', 'arm64', false, 'bridges-linux-arm64'],
  ['linux', 'arm64', true, 'bridges-linux-musl-arm64'],
  ['linux', 'x64', false, 'bridges-linux-x64'],
  ['linux', 'x64', true, 'bridges-linux-musl-x64'],
  ['win32', 'x64', false, 'bridges-win32-x64.exe'],
];

test('platform resolver owns every supported release binary name', () => {
  assert.deepEqual(SUPPORTED_PLATFORM_KEYS, [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);

  for (const [platform, arch, musl, expected] of targetCases) {
    assert.equal(
      resolvePlatformBinaryName({ cliName: 'bridges', platform, arch, musl }),
      expected,
    );
  }
});

test('platform resolver rejects targets that are not published', () => {
  assert.equal(
    resolvePlatformBinaryName({
      cliName: 'bridges',
      platform: 'freebsd',
      arch: 'x64',
      musl: false,
    }),
    null,
  );
  assert.equal(
    resolvePlatformBinaryName({
      cliName: 'bridges',
      platform: 'win32',
      arch: 'arm64',
      musl: false,
    }),
    null,
  );
});

test('musl detection avoids Linux probes on other platforms', () => {
  assert.equal(
    detectMusl({
      platform: 'darwin',
      readProcMaps: () => {
        throw new Error('must not read proc maps');
      },
      runLdd: () => {
        throw new Error('must not run ldd');
      },
    }),
    false,
  );
});

test('musl detection prefers proc maps and falls back to ldd output', () => {
  let lddCalls = 0;
  assert.equal(
    detectMusl({
      platform: 'linux',
      readProcMaps: () => '/lib/ld-musl-aarch64.so.1',
      runLdd: () => {
        lddCalls += 1;
        return { stdout: 'glibc', stderr: '' };
      },
    }),
    true,
  );
  assert.equal(lddCalls, 0);

  assert.equal(
    detectMusl({
      platform: 'linux',
      readProcMaps: () => {
        throw new Error('/proc unavailable');
      },
      runLdd: () => ({ stdout: '', stderr: 'musl libc' }),
    }),
    true,
  );
});

test('musl detection fails closed to the standard Linux build', () => {
  assert.equal(
    detectMusl({
      platform: 'linux',
      readProcMaps: () => 'glibc',
      runLdd: () => {
        throw new Error('ldd unavailable');
      },
    }),
    false,
  );
});
