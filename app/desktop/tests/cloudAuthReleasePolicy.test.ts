import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudAuthCapabilityDiscoveryEnabled,
  defaultCloudOAuthProviders,
} from '../src/features/cloud/cloudAuthReleasePolicy';

test('packaged apps default to product OAuth without debug capability discovery', () => {
  assert.equal(cloudAuthCapabilityDiscoveryEnabled({ DEV: false }), false);
  assert.equal(cloudAuthCapabilityDiscoveryEnabled({}), false);
  assert.deepEqual(defaultCloudOAuthProviders({ DEV: false }), ['google', 'github']);
  assert.deepEqual(defaultCloudOAuthProviders({}), ['google', 'github']);
});

test('development uses server capabilities and keeps community fallback disabled', () => {
  const communityEnv = {
    DEV: true,
    VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    VITE_KORDI_DEV_PROFILE: 'community',
  };
  assert.equal(cloudAuthCapabilityDiscoveryEnabled(communityEnv), true);
  assert.deepEqual(defaultCloudOAuthProviders(communityEnv), []);
});
