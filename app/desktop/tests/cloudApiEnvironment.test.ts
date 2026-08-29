import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatSyncWebSocketUrl,
  cloudApiBaseUrl,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  defaultCloudRequestTimeoutMs,
  operatorCloudOAuthProviderFallback,
} from '../src/features/cloud/authClient';

test('cloud API defaults to the hosted product origin outside development', () => {
  assert.equal(cloudApiBaseUrl({}), 'https://kordi.ai');
});

test('development cloud API requires an explicit non-production origin', () => {
  assert.throws(
    () => cloudApiBaseUrl({ DEV: true }),
    /VITE_KORDI_CLOUD_API_BASE is required for development/i,
  );
  for (const productionOrigin of [
    'https://kordi.ai:443/',
    'http://kordi.ai',
    'https://kordi.ai./',
  ]) {
    assert.throws(
      () => cloudApiBaseUrl({
        DEV: true,
        VITE_KORDI_CLOUD_API_BASE: productionOrigin,
      }),
      /production Cloud API is blocked in development/i,
    );
  }
  assert.equal(
    cloudApiBaseUrl({
      DEV: true,
      VITE_KORDI_CLOUD_API_BASE: ' http://127.0.0.1:17081/ ',
    }),
    'http://127.0.0.1:17081',
  );
  assert.equal(
    cloudApiBaseUrl({
      DEV: true,
      VITE_KORDI_CLOUD_API_BASE: 'https://staging.example.test/',
    }),
    'https://staging.example.test',
  );
});

test('operator development requires both the operator profile and production acknowledgement', () => {
  const baseEnv = {
    DEV: true,
    VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai',
  };
  assert.throws(
    () => cloudApiBaseUrl({ ...baseEnv, VITE_KORDI_DEV_PROFILE: 'operator' }),
    /blocked in development/i,
  );
  assert.throws(
    () => cloudApiBaseUrl({ ...baseEnv, VITE_KORDI_PRODUCTION_DEBUG_ACK: '1' }),
    /blocked in development/i,
  );
  assert.equal(
    cloudApiBaseUrl({
      ...baseEnv,
      VITE_KORDI_DEV_PROFILE: 'operator',
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    }),
    'https://kordi.ai',
  );
  assert.throws(
    () => cloudApiBaseUrl({
      ...baseEnv,
      VITE_KORDI_CLOUD_API_BASE: 'https://staging.example.test',
      VITE_KORDI_DEV_PROFILE: 'operator',
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    }),
    /approved .* product origin/i,
  );
});

test('acknowledged production operator previews retain OAuth when capability discovery is unavailable', () => {
  const operatorEnv = {
    DEV: true,
    VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai',
    VITE_KORDI_DEV_PROFILE: 'operator',
    VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
  };
  assert.deepEqual(operatorCloudOAuthProviderFallback(operatorEnv), ['google', 'github']);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_DEV_PROFILE: 'community',
  }), []);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_PRODUCTION_DEBUG_ACK: undefined,
  }), []);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_CLOUD_API_BASE: 'https://staging.example.test',
  }), []);
});

test('cloud auth client gives local SSH tunnels a longer default timeout', () => {
  assert.equal(defaultCloudRequestTimeoutMs('https://kordi.ai'), 15_000);
  assert.equal(defaultCloudRequestTimeoutMs('http://127.0.0.1:17081'), 45_000);
  assert.equal(defaultCloudRequestTimeoutMs('http://localhost:17081'), 45_000);
});

test('cloud realtime WebSockets stay off for local SSH tunnel tests', () => {
  assert.equal(cloudRealtimeWebSocketEnabled('https://kordi.ai'), true);
  assert.equal(cloudRealtimeWebSocketEnabled('https://kordi.ai', {
    DEV: true,
    VITE_KORDI_DEV_PROFILE: 'operator',
    VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
  }), false);
  assert.equal(cloudRealtimeWebSocketEnabled('http://127.0.0.1:17081'), false);
  assert.equal(cloudRealtimeWebSocketEnabled('http://localhost:17081'), false);
  assert.equal(cloudRealtimeWebSocketEnabled('http://127.0.0.1:17081', {
    DEV: true,
    VITE_KORDI_ENABLE_LOOPBACK_REALTIME: '1',
  }), true);
});

test('cloud WebSocket URL derives from the cloud API origin', () => {
  assert.equal(
    cloudWebSocketUrl('kordi_cs_token', 'https://kordi.ai'),
    'wss://kordi.ai/v1/cloud/ws?token=kordi_cs_token',
  );
  assert.equal(
    cloudWebSocketUrl('token with space', 'http://127.0.0.1:17081'),
    'ws://127.0.0.1:17081/v1/cloud/ws?token=token+with+space',
  );
});

test('reliable chat WebSocket uses a single-use chat ticket instead of an access token', () => {
  assert.equal(
    chatSyncWebSocketUrl('kordi_rt_ticket', 'https://kordi.ai'),
    'wss://kordi.ai/v2/chat/realtime?ticket=kordi_rt_ticket',
  );
});
