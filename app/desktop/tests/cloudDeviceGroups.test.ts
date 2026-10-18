import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudDeviceAuthorization } from '../src/features/cloud/cloudDeviceClient';
import {
  deviceRowTitle,
  deviceTitle,
  isPlaceholderDeviceName,
  lastActiveDescription,
  reviewEndsLabel,
  signInMethodLabel,
  splitCloudDevices,
} from '../src/features/cloud/cloudDeviceGroups';

const NOW = Date.parse('2026-10-07T12:00:00Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function device(overrides: Partial<CloudDeviceAuthorization> & { deviceId: string }): CloudDeviceAuthorization {
  return {
    displayName: 'MacBook Pro',
    platform: 'macos',
    osVersion: '26.0',
    appVersion: '0.0.2',
    createdAt: minutesAgo(10_000),
    lastActiveAt: minutesAgo(30),
    authorizationState: 'confirmed',
    currentDevice: false,
    sessionExpiresAt: null,
    approximateLocation: null,
    syncStatus: { protocolVersion: 2, lastAppliedSequence: 0, lastSuccessfulCatchUpAt: null },
    ...overrides,
  };
}

test('placeholder names are detected and replaced with a platform title', () => {
  assert.equal(isPlaceholderDeviceName('oauth-google-device'), true);
  assert.equal(isPlaceholderDeviceName('oauth-github-device'), true);
  assert.equal(isPlaceholderDeviceName('cloud-email-password-device'), true);
  assert.equal(isPlaceholderDeviceName('MacBook Pro'), false);
  assert.equal(isPlaceholderDeviceName(null), false);

  assert.equal(deviceTitle(device({ deviceId: 'a', displayName: 'oauth-google-device' })), 'Mac');
  assert.equal(deviceTitle(device({ deviceId: 'b', displayName: null, platform: 'ios' })), 'iPhone');
  assert.equal(deviceTitle(device({ deviceId: 'c', displayName: ' ', platform: 'windows' })), 'Windows PC');
  assert.equal(deviceTitle(device({ deviceId: 'd', displayName: null, platform: 'linux' })), 'Linux computer');
  assert.equal(deviceTitle(device({ deviceId: 'e', displayName: null, platform: null })), 'Kordi device');
  assert.equal(deviceTitle(device({ deviceId: 'f', displayName: '  Ada’s Mac ' })), 'Ada’s Mac');
});

test('legacy and placeholder rows are named by sign-in method', () => {
  assert.equal(deviceRowTitle(device({ deviceId: 'a', displayName: null, legacy: true, signInMethod: 'google' })), 'Google sign-in');
  assert.equal(deviceRowTitle(device({ deviceId: 'b', displayName: 'cloud-email-password-device', signInMethod: 'password' })), 'Email and password sign-in');
  assert.equal(deviceRowTitle(device({ deviceId: 'c', displayName: 'MacBook Pro' })), 'MacBook Pro');
});

test('split separates the current device, same-machine installs, and other devices', () => {
  const current = device({ deviceId: 'current', currentDevice: true, sameMachine: false, lastActiveAt: minutesAgo(0) });
  const sameOld = device({ deviceId: 'same-old', sameMachine: true, lastActiveAt: minutesAgo(600) });
  const samePending = device({ deviceId: 'same-pending', sameMachine: true, authorizationState: 'pending_review', lastActiveAt: minutesAgo(900) });
  const otherMac = device({ deviceId: 'other-mac', displayName: 'MacBook Pro', lastActiveAt: minutesAgo(5) });
  const legacy = device({ deviceId: 'legacy', displayName: null, legacy: true, lastActiveAt: minutesAgo(5_000) });
  const result = splitCloudDevices([sameOld, otherMac, current, legacy, samePending]);
  assert.equal(result.current?.deviceId, 'current');
  assert.deepEqual(result.sameMachine.map((row) => row.deviceId), ['same-pending', 'same-old']);
  assert.deepEqual(result.others.map((row) => row.deviceId), ['other-mac', 'legacy']);
});

test('rows without sameMachine (older servers) are other devices, even with the same name', () => {
  const result = splitCloudDevices([
    device({ deviceId: 'current', currentDevice: true, displayName: 'MacBook Pro' }),
    device({ deviceId: 'twin', displayName: 'MacBook Pro' }),
  ]);
  assert.deepEqual(result.sameMachine, []);
  assert.deepEqual(result.others.map((row) => row.deviceId), ['twin']);
  assert.equal(splitCloudDevices([device({ deviceId: 'x' })]).current, null);
});

test('rows sort pending first, then online, then most recent activity', () => {
  const result = splitCloudDevices([
    device({ deviceId: 'recent-offline', lastActiveAt: minutesAgo(1) }),
    device({ deviceId: 'old-online', lastActiveAt: minutesAgo(500), online: true }),
    device({ deviceId: 'old-pending', lastActiveAt: minutesAgo(3_000), authorizationState: 'pending_review' }),
    device({ deviceId: 'older-offline', lastActiveAt: minutesAgo(3_000) }),
    device({ deviceId: 'new-pending', lastActiveAt: minutesAgo(2), authorizationState: 'pending_review' }),
  ]);
  assert.deepEqual(
    result.others.map((row) => row.deviceId),
    ['new-pending', 'old-pending', 'old-online', 'recent-offline', 'older-offline'],
  );
});

test('review end labels format valid times only', () => {
  assert.equal(reviewEndsLabel(null), null);
  assert.equal(reviewEndsLabel(undefined), null);
  assert.equal(reviewEndsLabel('not a date'), null);
  assert.ok(reviewEndsLabel('2026-10-18T12:00:00Z'));
});

test('last active descriptions use minute, hour, and date boundaries', () => {
  assert.equal(lastActiveDescription(null, NOW), null);
  assert.equal(lastActiveDescription('not a date', NOW), null);
  assert.equal(lastActiveDescription(new Date(NOW - 59_999).toISOString(), NOW), 'Active just now');
  assert.equal(lastActiveDescription(new Date(NOW + 30_000).toISOString(), NOW), 'Active just now');
  assert.equal(lastActiveDescription(minutesAgo(1), NOW), 'Active 1 min ago');
  assert.equal(lastActiveDescription(minutesAgo(5), NOW), 'Active 5 min ago');
  assert.equal(lastActiveDescription(minutesAgo(59), NOW), 'Active 59 min ago');
  assert.equal(lastActiveDescription(minutesAgo(60), NOW), 'Active 1 hr ago');
  assert.equal(lastActiveDescription(minutesAgo(180), NOW), 'Active 3 hr ago');
  assert.equal(lastActiveDescription(minutesAgo(1_439), NOW), 'Active 23 hr ago');
  assert.match(lastActiveDescription(minutesAgo(1_440), NOW) ?? '', /^Last active /);
});

test('sign-in method labels name the provider', () => {
  assert.equal(signInMethodLabel('google'), 'Google');
  assert.equal(signInMethodLabel('GitHub'), 'GitHub');
  assert.equal(signInMethodLabel('password'), 'Email and password');
  assert.equal(signInMethodLabel('apple'), 'Apple');
  assert.equal(signInMethodLabel(null), 'Kordi');
  assert.equal(signInMethodLabel(undefined), 'Kordi');
  assert.equal(signInMethodLabel(''), 'Kordi');
});
