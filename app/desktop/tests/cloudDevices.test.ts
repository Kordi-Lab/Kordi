import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import {
  CLOUD_AGENT_DIRECTORY_SYNC_EVENT,
  CLOUD_DIRECTORY_SYNC_EVENT,
  publishCloudDeviceEvents,
} from '../src/features/cloud/cloudDeviceEvents';
import type { ChatSyncEvent } from '../src/features/cloud/chatSyncTypes';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('device settings keep session details concise while covering review and revocation', () => {
  const panel = readSource('features/cloud/CloudDevicesPanel.tsx');
  const settings = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(settings, /id: 'devices', label: 'Active sessions'/);
  assert.match(panel, /This device/);
  assert.match(panel, /Active devices/);
  assert.match(panel, /Rename this device/);
  assert.match(panel, /renameDevice/);
  assert.match(panel, /Terminate all other sessions/);
  assert.match(panel, /authorizationState === 'pending_review'/);
  assert.doesNotMatch(panel, /Showing the last device list/);
  assert.doesNotMatch(panel, /Device details unavailable/);
  assert.match(panel, /lastActiveAt/);
  assert.match(panel, /approximateLocation/);
  assert.doesNotMatch(panel, /First signed in/);
  assert.doesNotMatch(panel, /Sync cursor/);
  assert.doesNotMatch(panel, /Last catch-up/);
  assert.doesNotMatch(panel, /Sync protocol/);
  assert.doesNotMatch(panel, /Session expires/);
  assert.match(panel, /revokeOtherDevices/);
  assert.match(panel, /confirmation\.operationId/);
  assert.match(panel, /cannot erase files already saved/);
});

test('the sidebar routes device review through settings instead of the profile menu', () => {
  const sidebar = readSource('pages/workspaceSidebar.profile.tsx');
  const sync = readSource('features/cloud/useCloudMessageSync.ts');
  const deviceEvents = readSource('features/cloud/cloudDeviceEvents.ts');

  assert.match(sidebar, /accountId === cloudAccount\.accountId/);
  assert.match(sidebar, /if \(tab === 'devices' && cloudAccount\)/);
  assert.match(sidebar, /needsReview: false/);
  assert.doesNotMatch(sidebar, /Review active sessions/);
  assert.match(sidebar, /openCloudAccountDialog\(hasDeviceReview \? 'devices' : 'profile'\)/);
  assert.match(sync, /publishCloudDeviceEvents\(response\.chat\.events/);
  assert.match(deviceEvents, /event\.type === 'device\.added'/);
  assert.match(deviceEvents, /kordi-cloud-new-device/);
});

test('durable directory events refresh profiles without replacing the signed-in account', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements = {
    window: dom.window,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
  };
  const previous = new Map(Object.keys(replacements).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  let profileAccountId = '';
  let directoryRefreshes = 0;
  let changedAgentOwners: string[] = [];
  dom.window.addEventListener('kordi-cloud-profile-updated', (event) => {
    profileAccountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId ?? '';
  });
  dom.window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, () => { directoryRefreshes += 1; });
  dom.window.addEventListener(CLOUD_AGENT_DIRECTORY_SYNC_EVENT, (event) => {
    changedAgentOwners = (event as CustomEvent<{ ownerAccountIds?: string[] }>)
      .detail?.ownerAccountIds ?? [];
  });
  const event = (type: string, payload: Record<string, unknown>): ChatSyncEvent => ({
    stream_seq: 1,
    event_id: type,
    protocol_version: 2,
    type,
    critical: true,
    conversation_id: null,
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-19T00:00:00Z',
    payload,
  });

  try {
    publishCloudDeviceEvents([
      event('account.profile.updated', { account: { accountId: 'acct_me' } }),
      event('account.directory.changed', { accountId: 'acct_peer' }),
      event('agent.directory.changed', { ownerAccountId: 'acct_owner' }),
    ], 'acct_me', undefined);
    assert.equal(profileAccountId, 'acct_me');
    assert.equal(directoryRefreshes, 1);
    assert.deepEqual(changedAgentOwners, ['acct_owner']);
  } finally {
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});
