import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudDeviceAuthorization } from '../src/features/cloud/cloudDeviceClient';
import {
  deviceGroupKey,
  deviceTitle,
  groupCloudDevices,
  isPlaceholderDeviceName,
  lastActiveDescription,
  signInMethodLabel,
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

test('rows from the same Mac share a group key, legacy rows never do', () => {
  const first = device({ deviceId: 'a', displayName: 'MacBook Pro' });
  const second = device({ deviceId: 'b', displayName: ' macbook pro ' });
  assert.equal(deviceGroupKey(first), 'macos::macbook pro');
  assert.equal(deviceGroupKey(first), deviceGroupKey(second));
  const legacyRow = device({ deviceId: 'c', displayName: 'MacBook Pro', legacy: true });
  assert.notEqual(deviceGroupKey(legacyRow), deviceGroupKey(first));
  const placeholderRow = device({ deviceId: 'd', displayName: 'oauth-google-device' });
  assert.notEqual(deviceGroupKey(placeholderRow), deviceGroupKey(device({ deviceId: 'e', displayName: null })));
});

test('two rows of the same Mac form one group and the current device is excluded', () => {
  const current = device({ deviceId: 'current', displayName: 'MacBook Pro', currentDevice: true, lastActiveAt: minutesAgo(0) });
  const older = device({
    deviceId: 'older',
    displayName: 'MacBook Pro',
    osVersion: '15.6',
    lastActiveAt: minutesAgo(120),
    approximateLocation: 'Riyadh, Saudi Arabia',
    online: false,
  });
  const newer = device({
    deviceId: 'newer',
    displayName: 'MacBook Pro',
    osVersion: '26.0',
    lastActiveAt: minutesAgo(5),
    approximateLocation: 'Thuwal, Saudi Arabia',
    online: true,
    authorizationState: 'pending_review',
  });

  const result = groupCloudDevices([current, older, newer]);
  assert.equal(result.current?.deviceId, 'current');
  assert.equal(result.groups.length, 1);
  const [group] = result.groups;
  assert.equal(group.title, 'MacBook Pro');
  assert.equal(group.sessionCount, 2);
  assert.equal(group.online, true);
  assert.equal(group.pending, true);
  assert.equal(group.osVersion, '26.0');
  assert.equal(group.location, 'Thuwal, Saudi Arabia');
  assert.equal(group.lastActiveAt, newer.lastActiveAt);
  assert.deepEqual(group.devices.map((row) => row.deviceId), ['newer', 'older']);
  assert.deepEqual(result.legacy, []);
});

test('session counts default to one per row and sum across the group', () => {
  const result = groupCloudDevices([
    device({ deviceId: 'a', sessionCount: 3 }),
    device({ deviceId: 'b' }),
  ]);
  assert.equal(result.groups[0].sessionCount, 4);
  assert.equal(result.current, null);
});

test('legacy and placeholder rows go to the older sign-ins list, most recent first', () => {
  const result = groupCloudDevices([
    device({ deviceId: 'real', displayName: 'MacBook Pro' }),
    device({ deviceId: 'legacy-old', displayName: null, legacy: true, signInMethod: 'google', lastActiveAt: minutesAgo(5_000) }),
    device({ deviceId: 'placeholder', displayName: 'oauth-google-device', lastActiveAt: minutesAgo(60) }),
    device({ deviceId: 'password', displayName: 'cloud-email-password-device', lastActiveAt: minutesAgo(600) }),
  ]);
  assert.deepEqual(result.groups.map((group) => group.devices.map((row) => row.deviceId)), [['real']]);
  assert.deepEqual(result.legacy.map((row) => row.deviceId), ['placeholder', 'password', 'legacy-old']);
});

test('groups sort online devices first, then by most recent activity', () => {
  const result = groupCloudDevices([
    device({ deviceId: 'recent-offline', displayName: 'Studio', lastActiveAt: minutesAgo(1) }),
    device({ deviceId: 'old-online', displayName: 'Laptop', lastActiveAt: minutesAgo(500), online: true }),
    device({ deviceId: 'older-offline', displayName: 'iPhone', platform: 'ios', lastActiveAt: minutesAgo(3_000) }),
    device({ deviceId: 'new-online', displayName: 'Desk', lastActiveAt: minutesAgo(2), online: true }),
  ]);
  assert.deepEqual(
    result.groups.map((group) => group.devices[0].deviceId),
    ['new-online', 'old-online', 'recent-offline', 'older-offline'],
  );
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
