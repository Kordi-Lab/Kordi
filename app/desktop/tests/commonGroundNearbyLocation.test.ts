import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nearbyLocationInput } from '../src/features/commonGround/nearbyLocationFix';

test('nearby device location rejects stale, inaccurate, and invalid fixes before transmission', () => {
  const now = Date.now();
  const valid = { latitude: 40, longitude: -75, accuracy: 100, timestamp: now };
  for (const patch of [{ latitude: NaN }, { longitude: 181 }, { accuracy: -1 }, { accuracy: 2001 }, { timestamp: now - 600_001 }, { timestamp: now + 60_001 }]) {
    assert.throws(() => nearbyLocationInput({ ...valid, ...patch }, now));
  }
  assert.equal(nearbyLocationInput(valid, now).capturedAt, new Date(now).toISOString());
});
