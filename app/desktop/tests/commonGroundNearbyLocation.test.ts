import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { NearbyLocationError, nearbyLocationInput, nearbyNativeLocationError } from '../src/features/commonGround/nearbyLocationFix';

test('nearby device location rejects stale, inaccurate, and invalid fixes before transmission', () => {
  const now = Date.now();
  const valid = { latitude: 40, longitude: -75, accuracy: 100, timestamp: now };
  for (const patch of [{ latitude: NaN }, { longitude: 181 }, { accuracy: -1 }, { accuracy: 2001 }, { timestamp: now - 600_001 }, { timestamp: now + 60_001 }]) {
    assert.throws(() => nearbyLocationInput({ ...valid, ...patch }, now));
  }
  assert.equal(nearbyLocationInput(valid, now).capturedAt, new Date(now).toISOString());
});


test('native Nearby location ships the signed entitlement and usage description needed for the permission prompt', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.bundle.macOS.entitlements, './Entitlements.plist');
  const entitlements = readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url), 'utf8');
  assert.match(entitlements, /<key>com\.apple\.security\.personal-information\.location<\/key>\s*<true\s*\/>/);
  const info = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.match(info, /<key>NSLocationUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
});

test('native location failures map to copy, with Location Services only for permission problems', () => {
  const denied = nearbyNativeLocationError(new Error('location_denied'));
  assert.ok(denied instanceof NearbyLocationError);
  assert.equal(denied.message, 'Allow Kordi in Location Services, then try again.');
  assert.equal(denied.settings, true);
  for (const code of ['location_services_off', 'location_permission_pending']) {
    assert.equal((nearbyNativeLocationError(new Error(code)) as NearbyLocationError).settings, true);
  }
  for (const code of ['location_timeout', 'location_unavailable', 'location_busy', 'location_not_bundled']) {
    const error = nearbyNativeLocationError(new Error(code));
    assert.ok(error instanceof NearbyLocationError);
    assert.equal(error.settings, false);
    assert.doesNotMatch(error.message, /location_/);
  }
  const other = new Error('Network failed.');
  assert.equal(nearbyNativeLocationError(other), other);
});

test('native location asks for permission before reading a fix and never treats an unanswered prompt as a fix failure', () => {
  const source = readFileSync(new URL('../src-tauri/src/nearby_location/macos.rs', import.meta.url), 'utf8');
  assert.match(source, /requestWhenInUseAuthorization\(\)/);
  assert.doesNotMatch(source, /requestLocation\(\)/);
  assert.match(source, /bundleIdentifier\(\)/);
});
