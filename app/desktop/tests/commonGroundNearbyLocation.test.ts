import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { nearbyLocationInput } from '../src/features/commonGround/nearbyLocationFix';

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
